// BullMQ outbound send queue. Rate-limited at 60 messages/sec by default
// (well under Meta Tier 1's 80/sec ceiling). All four send-origin paths
// (chat reply, broadcast, automation, template test) enqueue here.

const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedisSdk = require('ioredis');
// CJS/default normalization (same as the LLM adapters): the package types
// describe the ESM namespace, not the resolved CJS value.
/** @type {any} */
const IORedis = IORedisSdk && IORedisSdk.default ? IORedisSdk.default : IORedisSdk;
const pool = require('../db');
const { getAccountWithToken } = require('../routes/whatsappAccounts');
const { tenantJobAllowed } = require('../tenancy/scope');
const { sendText, sendTemplate, sendMedia, sendInteractive, sendLocation, sendContacts, sendReaction } = require('../integrations/metaSend');
const { markSent, markFailed } = require('../services/messageSender');
const { markAccountHealth, classifyMetaError } = require('../services/accountHealth');

// Non-retryable worker failure (typed so the failed-handler below can match
// on it without touching untyped Error internals).
class SkipRetryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipRetryError';
    this.skipRetry = true;
  }
}

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'forgecrm-send';
const CONCURRENCY = parseInt(process.env.SEND_QUEUE_CONCURRENCY || '5', 10);
const RATE_MAX = parseInt(process.env.SEND_RATE_MAX || '60', 10);
const RATE_DURATION_MS = parseInt(process.env.SEND_RATE_DURATION_MS || '1000', 10);
const ATTEMPTS = parseInt(process.env.SEND_QUEUE_ATTEMPTS || '4', 10);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', err => console.error('[sendQueue] redis error:', err.message));

const sendQueue = new Queue(QUEUE_NAME, { connection });

let worker = null;
let queueEvents = null;

/**
 * Job data shape:
 * {
 *   kind: 'text' | 'template' | 'media',
 *   accountId: number,        // resolved WhatsApp account id
 *   to: string,               // recipient phone (digits only)
 *   localMessageId: string,   // matches the optimistic chat_history row
 *   payload: {                // shape depends on kind
 *     // text:    { body, previewUrl? }
 *     // template:{ name, languageCode, components, broadcastLogId? }
 *     // media:   { type, mediaId | link, caption?, filename? }
 *   },
 *   originRef?: {             // optional cross-table linkage for status writes
 *     kind: 'broadcast_log' | 'automation_step',
 *     id: number,
 *   }
 * }
 */
async function processJob(job) {
  const { kind, accountId, to, localMessageId, payload, originRef, organizationId } = job.data || {};
  const account = await getAccountWithToken(accountId);
  if (!account) throw new Error(`Account id=${accountId} not found`);
  // Step 9 tenant guard: a job stamped for org A must never send through org
  // B's credentials. Legacy unstamped jobs and unassigned accounts pass through
  // (dual-read); an explicit mismatch fails fast with no retry.
  if (!tenantJobAllowed(organizationId, account.organizationId)) {
    throw new SkipRetryError(`Tenant mismatch: job org ${organizationId} != account org ${account.organizationId}`);
  }
  if (!account.accessToken) throw new Error('Access token missing');
  if (!account.isActive) throw new Error(`Account "${account.displayName}" is inactive`);

  const args = {
    accessToken: account.accessToken,
    phoneNumberId: account.phoneNumberId,
    to,
  };

  let result;
  try {
    if (kind === 'text') {
      result = await sendText({ ...args, body: payload.body, previewUrl: payload.previewUrl, contextMessageId: payload.contextMessageId });
    } else if (kind === 'template') {
      result = await sendTemplate({ ...args, templateName: payload.name, languageCode: payload.languageCode, components: payload.components });
    } else if (kind === 'media') {
      result = await sendMedia({ ...args, type: payload.type, mediaId: payload.mediaId, link: payload.link, caption: payload.caption, filename: payload.filename, contextMessageId: payload.contextMessageId });
    } else if (kind === 'interactive') {
      result = await sendInteractive({ ...args, interactive: payload.interactive });
    } else if (kind === 'location') {
      result = await sendLocation({ ...args, latitude: payload.latitude, longitude: payload.longitude, name: payload.name, address: payload.address });
    } else if (kind === 'contacts') {
      result = await sendContacts({ ...args, contacts: payload.contacts });
    } else if (kind === 'reaction') {
      result = await sendReaction({ ...args, messageId: payload.messageId, emoji: payload.emoji });
    } else {
      throw new Error(`unknown send kind: ${kind}`);
    }
    await markAccountHealth(account.id, 'healthy');
  } catch (err) {
    const cls = classifyMetaError(err);
    await markAccountHealth(account.id, cls, err.message);
    // Don't retry auth failures — they'll fail every time until token is fixed
    if (cls === 'invalid_token') {
      err.skipRetry = true;
    }
    throw err;
  }

  const wamid = result?.messages?.[0]?.id;
  if (!wamid) throw new Error('Meta returned no message id');

  // Swap the optimistic row's local id for the real wamid
  if (localMessageId) await markSent(localMessageId, wamid);

  // Phase 7 worker→socket boundary: the job's validated organizationId is the
  // ONLY tenant source (tenantJobAllowed already enforced it above — an
  // explicit mismatch threw before any Meta call). No org → no socket emit
  // (fail closed); the UI still converges via polling.
  if (organizationId && localMessageId) {
    try {
      require('../realtime/emitter').emitMessageStatus(organizationId, {
        messageId: wamid,
        // Recipient context for the inbox to match the conversation. waNumber
        // is intentionally omitted here — the frontend matches on messageId.
        contactNumber: to,
        status: 'sent',
      });
    } catch (err) {
      console.error('[sendQueue] realtime emit failed:', err.message);
    }
  }

  // Update origin-side linkage (broadcast_log etc) if provided. Scoped to the
  // job's validated org so a forged originRef can never flip another tenant's
  // status. Steps have no org column — scope via their parent execution.
  if (originRef?.kind === 'broadcast_log' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.broadcast_logs
          SET status = 'sent', wa_message_id = $1, sent_at = NOW()
        WHERE id = $2 ${organizationId ? `AND (organization_id = $3 OR organization_id IS NULL)` : `AND organization_id IS NULL`}`,
      organizationId ? [wamid, originRef.id, organizationId] : [wamid, originRef.id]
    ).catch(err => console.error('[sendQueue] broadcast_log update failed:', err.message));
  }
  if (originRef?.kind === 'automation_step' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.automation_execution_steps
          SET wa_message_id = $1, wa_message_status = 'sent'
        WHERE id = $2 ${organizationId ? `AND execution_id IN (SELECT id FROM coexistence.automation_executions WHERE organization_id = $3)` : ``}`,
      organizationId ? [wamid, originRef.id, organizationId] : [wamid, originRef.id]
    ).catch(() => {});
  }

  return { wamid };
}

function startSendWorker() {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
  });

  worker.on('completed', (job) => {
    console.log(`[sendQueue] ${job.data?.kind} to ${job.data?.to} → ${job.returnvalue?.wamid}`);
  });
  worker.on('failed', async (job, err) => {
    const localId = job?.data?.localMessageId;
    const skipRetry = (err instanceof SkipRetryError) || /invalid.*token|access token has expired|Error validating access token/i.test(err?.message || '');
    const finalAttempt = (job?.attemptsMade || 0) >= ATTEMPTS || skipRetry;
    console.error(`[sendQueue] ${job?.data?.kind} to ${job?.data?.to} failed attempt=${job?.attemptsMade}/${ATTEMPTS}${skipRetry ? ' (no-retry: auth)' : ''}: ${err.message}`);
    if (finalAttempt && localId) {
      await markFailed(localId, err.message).catch(() => {});
      // Phase 7: surface the terminal failure to the org room (same tenant
      // boundary — the job's validated org, never inferred).
      if (job?.data?.organizationId) {
        try {
          require('../realtime/emitter').emitMessageStatus(job.data.organizationId, {
            messageId: localId,
            contactNumber: job?.data?.to,
            status: 'failed',
          });
        } catch (emitErr) {
          console.error('[sendQueue] realtime emit failed:', emitErr.message);
        }
      }
      if (job?.data?.originRef?.kind === 'broadcast_log') {
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2
            ${job.data.organizationId ? `AND (organization_id = $3 OR organization_id IS NULL)` : `AND organization_id IS NULL`}`,
          job.data.organizationId
            ? [err.message.slice(0, 500), job.data.originRef.id, job.data.organizationId]
            : [err.message.slice(0, 500), job.data.originRef.id]
        ).catch(() => {});
      }
    }
  });

  queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  queueEvents.on('error', err => console.error('[sendQueue] events error:', err.message));

  console.log(`[sendQueue] worker started, concurrency=${CONCURRENCY}, rate=${RATE_MAX}/${RATE_DURATION_MS}ms, attempts=${ATTEMPTS}`);
  return worker;
}

async function enqueueSend(jobData, opts = {}) {
  // Step 9: every job carries tenant context. Callers may omit it; the queue
  // resolves the account's org (single indexed lookup) so workers can enforce
  // the boundary without trusting any caller.
  if (!jobData.organizationId && jobData.accountId) {
    try {
      const account = await getAccountWithToken(jobData.accountId);
      if (account?.organizationId) jobData.organizationId = account.organizationId;
    } catch { /* worker re-validates; never block enqueue on the lookup */ }
  }
  const idKey = jobData.localMessageId || `${jobData.accountId}-${jobData.to}-${Date.now()}`;
  const addOpts = {
    jobId: `send-${idKey}`,
    attempts: ATTEMPTS,
    backoff: { type: 'exponential', delay: 1500 },
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 1000, age: 86400 },
  };
  // Optional delayed delivery (used by automation Delay nodes so a later message
  // lands after an earlier one). BullMQ holds the job for `delayMs` before a
  // worker picks it up — non-blocking, no scheduler needed.
  if (opts.delayMs && opts.delayMs > 0) addOpts.delay = Math.round(opts.delayMs);
  await sendQueue.add('send', jobData, addOpts);
}

async function shutdownSendQueue() {
  try {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    await sendQueue.close();
    await connection.quit();
  } catch (err) {
    console.error('[sendQueue] shutdown error:', err.message);
  }
}

module.exports = { sendQueue, startSendWorker, enqueueSend, shutdownSendQueue };
