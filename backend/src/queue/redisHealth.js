// Shared Redis health probe for the /ready endpoint (Phase 13).
//
// Lazily creates ONE short-timeout client on first use (never at require
// time, so importing this module — e.g. in tests — opens no connections).
// Returns a boolean only; errors/URLs never propagate to callers.

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

let client = null;
let failedAt = 0;
const COOLDOWN_MS = 10_000;

async function getRedisStatus() {
  // Avoid hammering a down Redis on every probe tick.
  if (client === null && Date.now() - failedAt < COOLDOWN_MS) return false;
  try {
    if (!client) {
      const IORedis = require('ioredis');
      client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        connectTimeout: 2000,
        lazyConnect: true,
      });
      client.on('error', () => { /* readiness only; logged by callers */ });
    }
    const pong = await client.ping();
    return pong === 'PONG';
  } catch {
    failedAt = Date.now();
    try { if (client) { client.disconnect(); } } catch { /* ignore */ }
    client = null;
    return false;
  }
}

async function closeRedisHealth() {
  if (client) {
    try { await client.quit(); } catch { try { client.disconnect(); } catch { /* ignore */ } }
    client = null;
  }
}

module.exports = { getRedisStatus, closeRedisHealth };
