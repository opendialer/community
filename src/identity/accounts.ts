import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db.js';
import { addLogContext, log } from '../log.js';
import { accepted, body, code, email, errors, invalidCode, json, password, security, transaction } from './common.js';
import { consumeCode, queueEmail, verifyCodeSignature, type Purpose } from './mail.js';

const tags = ['Authentication'];
const userSchema = z.object({ id: z.uuid(), email: z.email() });
const creds = z.object({ email, password: z.string().min(1).max(256) });
const challenge = z.object({ code, password });
const complete = { 200: json(accepted, 'Operation completed'), ...errors };
const queued = { 202: json(accepted, 'Email queued when eligible'), ...errors };
const digest = (value: string) => createHash('sha256').update(value).digest();

function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (err, result) => err ? reject(err) : resolve(result));
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await derive(password, salt)).toString('hex');
}

export async function limit(key: string, maximum: number) {
  const result = await pool.query(
    `INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES ($1,1,now()+interval '15 minutes')
     ON CONFLICT (bucket) DO UPDATE SET
       attempts=CASE WHEN auth_rate_limits.expires_at<=now() THEN 1 ELSE auth_rate_limits.attempts+1 END,
       expires_at=CASE WHEN auth_rate_limits.expires_at<=now() THEN excluded.expires_at ELSE auth_rate_limits.expires_at END
     RETURNING attempts, greatest(1,ceil(extract(epoch from expires_at-now()))) AS retry`, [digest(key)]
  );
  if (result.rows[0].attempts > maximum) {
    // Name the limiter only; the key carries addresses and IPs.
    log.warn('rate_limited', { status: 429, reason: 'rate_limit_exceeded', limiter: key.startsWith('ip:') ? key.split(':', 2).join(':') : key.split(/[:/]/)[0], maximum, retryAfterSeconds: Number(result.rows[0].retry) });
    throw new HTTPException(429, { message: 'Try again later',res:new Response(null,{status:429,headers:{'Retry-After':String(result.rows[0].retry)}}) });
  }
}

async function throttle(c: Context, address: string, action: string, max: number) {
  let ip: string | undefined;
  if (process.env.TRUST_CADDY === 'true') ip = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (!ip && c.env?.incoming) ip = getConnInfo(c).remote.address;
  if (ip) await limit('ip:' + action + ':' + ip, 100);
  await limit(action + ':' + address, max);
}

export function tokenHash(request: Request) {
  const header = request.headers.get('authorization');
  const token = /^Bearer ([\w-]{43})$/i.exec(header ?? '')?.[1];
  if (!token) {
    log.warn('session_rejected', { status: 401, reason: header ? 'malformed_token' : 'missing_authorization' });
    throw new HTTPException(401, { message: 'Valid bearer session required' });
  }
  return digest(token);
}

// Called only when no active session matched; explains why without logging the token or its digest.
export async function rejectSession(hash: Buffer): Promise<never> {
  let reason = 'unknown_or_revoked';
  try {
    const { rows: [stale] } = await pool.query('SELECT user_id,expires_at<=now() AS idle,absolute_expiry<=now() AS absolute FROM sessions WHERE token_hash=$1', [hash]);
    if (stale) {
      addLogContext({ userId: stale.user_id });
      reason = stale.absolute ? 'absolute_expired' : stale.idle ? 'idle_expired' : reason;
    }
  } catch (error) {
    // Diagnostics must not change the response, but say that the reason below is only a guess.
    log.warn('session_diagnostics_failed', { reason: 'session_lookup_failed', error });
  }
  log.warn('session_rejected', { status: 401, reason });
  throw new HTTPException(401, { message: 'Session expired or invalid' });
}

export async function requireUser(request: Request): Promise<{ id: string; email: string }> {
  const hash = tokenHash(request);
  const result = await pool.query(
    'SELECT u.id,u.email FROM active_session($1) s JOIN users u ON u.id=s.user_id',
    [hash]
  );
  if (!result.rowCount) return rejectSession(hash);
  addLogContext({ userId: result.rows[0].id });
  return result.rows[0];
}

export function registerAccounts(app: OpenAPIHono) {
  for (const purpose of ['verify', 'reset'] as const) {
    const register = purpose === 'verify';
    app.openapi(createRoute({
      tags, method: 'post', operationId: register ? 'requestRegistration' : 'requestPasswordReset', path: register ? '/v1/auth/register' : '/v1/auth/forgot-password',
      summary: register ? 'Request a registration code by email' : 'Request a password reset code',
      request: { body: body(z.object({ email })) }, responses: queued
    }), async c => {
      const { email: address } = c.req.valid('json');
      await throttle(c, address, purpose, 4);
      let issued: { messageId: string; purpose: Purpose } | undefined;
      await transaction(async db => {
        const existing = await db.query('SELECT id FROM users WHERE email=$1', [address]);
        if(register || existing.rowCount){
          const messagePurpose = register && existing.rowCount?'existing':purpose;
          issued = { messageId: await queueEmail(db,address,messagePurpose), purpose: messagePurpose };
        }
      });
      // Logged after COMMIT: the message row only exists for the worker once the transaction succeeded.
      if (issued) log.info('identity_code_issued', issued);
      else log.info('password_reset_skipped', { reason: 'unknown_account' });
      return c.json({ accepted: true as const }, 202);
    });

    app.openapi(createRoute({
      tags, method: 'post', operationId: register ? 'completeRegistration' : 'resetPassword', path: register ? '/v1/auth/verify-email' : '/v1/auth/reset-password',
      summary: register ? 'Verify email and choose a password' : 'Choose a new password and revoke all sessions',
      request: { body: body(challenge) }, responses: complete
    }), async c => {
      const input = c.req.valid('json');
      verifyCodeSignature(input.code,purpose);
      const hash = await hashPassword(input.password);
      let userId: string | undefined;
      let sessionsRevoked = 0;
      await transaction(async db => {
        const msg = await consumeCode(db, input.code, purpose);
        if (register) {
          const user = await db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [msg.email, hash]);
          if (!user.rowCount) invalidCode('account_exists', { purpose });
          userId = user.rows[0].id;
        } else {
          const user = await db.query(
            `UPDATE users SET password_hash=$1,password_changed_at=clock_timestamp() WHERE email=$2
             AND password_changed_at < (SELECT created_at FROM identity_messages WHERE id=$3) RETURNING id`,
            [hash, msg.email, msg.id]);
          if (!user.rowCount) invalidCode('superseded', { purpose });
          userId = user.rows[0].id;
          sessionsRevoked = (await db.query('DELETE FROM sessions WHERE user_id=$1', [user.rows[0].id])).rowCount ?? 0;
        }
      });
      addLogContext({ userId });
      log.info('email_code_verified', { purpose });
      if (register) log.info('user_registered', { via: 'email_code' });
      else log.info('password_reset_completed', { sessionsRevoked });
      return c.json({ accepted: true as const }, 200);
    });
  }

  app.openapi(createRoute({
    tags, method: 'post', operationId: 'login', path: '/v1/auth/login', summary: 'Create a bearer session with seven-day idle and thirty-day absolute expiry',
    request: { body: body(creds) },
    responses: { 200: json(z.object({ accessToken: z.string(), tokenType: z.literal('Bearer'), expiresAt: z.iso.datetime(), user: userSchema }), 'Authenticated session'), ...errors }
  }), async c => {
    const input = c.req.valid('json');
    await throttle(c, input.email, 'login', 30);
    const lookup = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [input.email]);
    const user = lookup.rows[0];
    const [salt, hash] = (user?.password_hash ?? 'unknown:' + '0'.repeat(64)).split(':');
    const valid = timingSafeEqual(await derive(input.password, salt), Buffer.from(hash, 'hex'));
    if (!valid || !user) {
      if (user) addLogContext({ userId: user.id });
      log.warn('login_failed', { status: 401, reason: user ? 'bad_password' : 'unknown_user' });
      throw new HTTPException(401, { message: 'Invalid email or password' });
    }
    addLogContext({ userId: user.id });
    const token = randomBytes(32).toString('base64url');
    const session = await transaction(async db => {
      const locked = await db.query('SELECT id FROM users WHERE id=$1 AND password_hash=$2 FOR UPDATE', [user.id,user.password_hash]);
      if (!locked.rowCount) {
        log.warn('login_failed', { status: 401, reason: 'credentials_changed' });
        throw new HTTPException(401, { message: 'Credentials changed' });
      }
      return db.query(`INSERT INTO sessions(user_id, token_hash,expires_at) VALUES ($1,$2,now()+interval '7 days') RETURNING expires_at`,
        [user.id,digest(token)]);
    });
    log.info('login_succeeded', { sessionExpiresAt: session.rows[0].expires_at.toISOString() });
    c.header('Cache-Control','no-store');
    return c.json({ accessToken: token, tokenType: 'Bearer' as const, expiresAt: session.rows[0].expires_at.toISOString(),
      user: { id: user.id, email: user.email } }, 200);
  });

  app.openapi(createRoute({
    tags, method: 'get', operationId: 'getCurrentUser', path: '/v1/auth/me', security, summary: 'Get the current account',
    responses: { 200: json(userSchema.extend({expiresAt:z.iso.datetime()}), 'Current account and renewed session expiry'), ...errors }
  }), async c => {
    const hash=tokenHash(c.req.raw);
    const {rows:[session]}=await pool.query('SELECT u.id,u.email,s.expires_at AS expiry FROM active_session($1) s JOIN users u ON u.id=s.user_id',[hash]);
    if(!session)return rejectSession(hash);
    addLogContext({userId:session.id});
    return c.json({id:session.id,email:session.email,expiresAt:session.expiry.toISOString()},200);
  });

  app.openapi(createRoute({
    tags, method: 'post', operationId: 'logout', path: '/v1/auth/logout', security, summary: 'Revoke the current bearer session',
    responses: complete
  }), async c => {
    const revoked = await pool.query('DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id', [tokenHash(c.req.raw)]);
    if (revoked.rowCount) addLogContext({ userId: revoked.rows[0].user_id });
    log.info('logout', { sessionFound: Boolean(revoked.rowCount) });
    return c.json({ accepted: true as const }, 200);
  });
}
