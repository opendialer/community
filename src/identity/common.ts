import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { callSite, log } from '../log.js';

export async function transaction<T>(action: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await action(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    // A failed rollback must not hide the error that caused it.
    await db.query('ROLLBACK').catch(rollbackError => log.error('transaction_rollback_failed', { reason: 'rollback_failed', error: rollbackError }));
    throw error;
  } finally {
    db.release();
  }
}

export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const password = z.string().min(15).max(256);
export const code = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
export const accepted = z.object({ accepted: z.literal(true) });
export const security = [{ bearerAuth: [] }];
export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}
export function body<T extends z.ZodType>(schema: T) {
  return { required: true as const, content: { 'application/json': { schema } } };
}
export const errors = {
  400: { description: 'Invalid request or expired code' },
  401: { description: 'Authentication required or credentials invalid' },
  403: { description: 'Insufficient permission' },
  404: { description: 'Resource unavailable' },
  409: { description: 'Conflicting resource state' },
  429: { description: 'Request limit reached', headers:{'Retry-After':{description:'Seconds before retrying',schema:{type:'integer' as const,minimum:1}}} }
};
export function invalidCode(reason = 'invalid', fields: Record<string, unknown> = {}): never {
  log.warn('code_rejected', { status: 400, reason, where: callSite(), ...fields });
  throw new HTTPException(400, { message: 'Invalid or expired code' });
}
