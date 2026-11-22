import { transactionalEmail } from '../email/transactional.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction, invalidCode } from './common.js';

export type Purpose = 'verify' | 'reset' | 'invite' | 'existing';

const messages = {
  existing: {heading:'Sign In to OpenDialer',action:'Sign In',description:'An OpenDialer account already exists for this email. Sign in with your password or choose Forgot Password to recover access.',path:'/login',subject:'You already have an OpenDialer account'},
  verify: { heading: 'Verify Your Email', action: 'Verify Email', description: 'Verify your email address to finish creating your OpenDialer account.', path: '/verify-email', subject: 'Complete your OpenDialer registration' },
  reset: { heading: 'Reset Your Password', action: 'Reset Password', description: 'Use the link below to choose a new OpenDialer password. If you didn’t request this, you can ignore this email.', path: '/reset-password', subject: 'Reset your OpenDialer password' },
  invite: { heading: 'Team Invitation', action: 'Accept Invitation', description: 'You have been invited to join a team on OpenDialer.', path: '/accept-invitation', subject: 'Join your team on OpenDialer' }
};

function signature(id: string, purpose: Purpose) {
  const key = process.env.APP_SECRET;
  if (!key || key.length < 32) throw new Error('APP_SECRET must contain at least 32 characters');
  return createHmac('sha256', key).update('identity:v1:' + purpose + ':' + id).digest('base64url');
}

export async function queueEmail(db: PoolClient, address: string, purpose: Purpose) {
  const lifetime = { verify: '1 hour', reset: '30 minutes', invite: '7 days', existing:'1 hour' }[purpose];
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO identity_messages(email, purpose, expires_at) VALUES ($1,$2,now()+$3::interval) RETURNING id',
    [address, purpose, lifetime]
  );
  return rows[0]!.id;
}

export function verifyCodeSignature(code: string, purpose: Purpose) {
  const [id, mac] = code.split('.');
  if (!id || !mac || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) invalidCode();
  const expected = Buffer.from(signature(id, purpose));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalidCode();
  return id;
}

export async function consumeCode(db: PoolClient, code: string, purpose: Purpose) {
  const id = verifyCodeSignature(code,purpose);
  const result = await db.query<{ id: string; email: string }>(
    `UPDATE identity_messages SET consumed_at=now()
     WHERE id=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id,email`,
    [id, purpose]
  );
  return result.rows[0] ?? invalidCode();
}

export async function deliverIdentityEmail(send: typeof fetch = fetch): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const frontend = process.env.FRONTEND_URL;
  if (!key || !from || !frontend) return false;
  return transaction(async db => {
    const claim = await db.query<{id: string; purpose: Purpose; email: string; organization: string|null; legacy_email_design: boolean}>(
      `SELECT m.id,m.purpose,m.email,m.legacy_email_design,o.name AS organization FROM identity_messages m
       LEFT JOIN invitations i ON i.id=m.id LEFT JOIN organizations o ON o.id=i.organization_id
       WHERE sent_at IS NULL AND consumed_at IS NULL AND next_attempt_at<=now() AND expires_at>now()
       ORDER BY next_attempt_at,m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`
    );
    const job = claim.rows[0];
    if (!job) return false;
    const code = job.id + '.' + signature(job.id, job.purpose);
    const template = messages[job.purpose];
    const link = new URL(template.path, frontend);
    if(job.purpose!=='existing')link.hash = new URLSearchParams({ code }).toString();
    let providerStatus: number | undefined;
    try {
      const invitation = job.organization ? 'You have been invited to join ' + job.organization.replace(/\s+/g,' ') + ' on OpenDialer' : undefined;
      const content = job.legacy_email_design
        ? {text: (invitation ?? template.subject) + '\n\n' + link.href + '\n\nOr enter this code:\n' + code}
        : transactionalEmail({heading:template.heading, description:invitation ? invitation+'.' : template.description, action:{label:template.action,url:link},code:job.purpose==='existing'?undefined:code});
      const result = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': job.id },
        body: JSON.stringify({ from, to: [job.email], subject: template.subject,
          ...content }),
        signal: AbortSignal.timeout(8000)
      });
      providerStatus=result.status;
      if (!result.ok) throw new Error('Resend HTTP ' + result.status);
    } catch {
      await db.query(`UPDATE identity_messages SET attempts=attempts+1,
        next_attempt_at=now()+least(3600,30 * (2 ^ least(attempts,7))) * interval '1 second' WHERE id=$1`, [job.id]);
      console.warn(JSON.stringify({event:'identity_delivery_deferred',jobId:job.id,providerStatus:providerStatus??null}));
      return true;
    }
    await db.query('UPDATE identity_messages SET sent_at=now() WHERE id=$1', [job.id]);
    return true;
  });
}
