import { log } from '../log.js';
import { transaction } from './common.js';

// Bounded batches keep an expired registration backlog from monopolizing the worker.
export async function pruneIdentityData() {
  const started = performance.now();
  const pruned = await transaction(async db => {
    const sessions = await db.query(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at<now() LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    const rateLimits = await db.query(`DELETE FROM auth_rate_limits WHERE bucket IN (
      SELECT bucket FROM auth_rate_limits WHERE expires_at<now() LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    const messages = await db.query(`DELETE FROM identity_messages WHERE id IN (
      SELECT id FROM identity_messages WHERE expires_at < now()-interval '7 days' LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    return { sessions: sessions.rowCount, rateLimits: rateLimits.rowCount, messages: messages.rowCount };
  });
  log.info('identity_retention_pruned', { ...pruned, durationMs: Math.round(performance.now() - started) });
}
