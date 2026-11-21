import { transaction } from './common.js';

// Bounded batches keep an expired registration backlog from monopolizing the worker.
export async function pruneIdentityData() {
  await transaction(async db => {
    await db.query(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at<now() LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    await db.query(`DELETE FROM auth_rate_limits WHERE bucket IN (
      SELECT bucket FROM auth_rate_limits WHERE expires_at<now() LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    await db.query(`DELETE FROM identity_messages WHERE id IN (
      SELECT id FROM identity_messages WHERE expires_at < now()-interval '7 days' LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  });
}
