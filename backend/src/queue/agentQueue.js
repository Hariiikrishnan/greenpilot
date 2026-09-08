// Agent inference queue. The webhook handler enqueues; this worker runs the
// agent's LLM tool-use loop off the request path so Meta doesn't time out (20s
// webhook ceiling). Per-contact serial processing prevents two simultaneous
// agent runs from sending out-of-order replies to the same chat.

const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const pool = require('../db');
const { tenantJobAllowed } = require('../tenancy/scope');
const { runAgent } = require('../engine/agentEngine');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'forgechat-agent';
const CONCURRENCY = parseInt(process.env.AGENT_QUEUE_CONCURRENCY || '4', 10);
const ATTEMPTS = parseInt(process.env.AGENT_QUEUE_ATTEMPTS || '2', 10);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', err => console.error('[agentQueue] redis error:', err.message));

const agentQueue = new Queue(QUEUE_NAME, { connection });

let worker = null;
let queueEvents = null;

async function processJob(job) {
  const { agentId, contactNumber, inboundMessageId, inboundText, organizationId } = job.data || {};
  // Tenant guard: re-resolve the agent's AND account's org at execution time
  // (never trust the queued value alone) and refuse cross-org execution. A
  // refusal COMPLETES the job (no retry — retrying cannot fix a mismatch).
  if (organizationId) {
    const { rows } = await pool.query(
      `SELECT a.organization_id AS agent_org, w.organization_id AS account_org
         FROM coexistence.agents a
         LEFT JOIN coexistence.whatsapp_accounts w ON w.id = a.wa_account_id
        WHERE a.id = $1`,
      [agentId]
    );
    const agentOrg = rows[0]?.agent_org || null;
    const accountOrg = rows[0]?.account_org || null;
    if (!tenantJobAllowed(organizationId, accountOrg) ||
        (agentOrg && String(agentOrg) !== String(organizationId))) {
      console.error(`[agentQueue] refused cross-org run: job org ${organizationId} vs agent org ${agentOrg} / account org ${accountOrg}`);
      return { status: 'refused-tenant-mismatch', runId: null };
    }
    // Duplicate-delivery guard: this message already produced (and charged)
    // an AI run — skip the LLM call entirely, not just the charge.
    if (inboundMessageId) {
      const { hasAiUsage } = require('../billing/quotas');
      if (await hasAiUsage(pool, organizationId, inboundMessageId)) {
        return { status: 'duplicate-skipped', runId: null };
      }
    }
    // Quota gate BEFORE execution (Phase 8 order: entitlement → availability
    // → execution → debit). Over-quota/unentitled runs never reach the model.
    const { checkQuota } = require('../billing/quotas');
    const { RUN_COST } = require('../ai/qualification');
    const gate = await checkQuota(pool, organizationId, 'ai_credits', RUN_COST);
    if (!gate.allowed) {
      console.warn(`[agentQueue] agent=${agentId} contact=${contactNumber} skipped: ${gate.reason}`);
      return { status: 'skipped-quota', reason: gate.reason, runId: null };
    }
  }

  let result;
  try {
    result = await runAgent({
      agentId, contactNumber, inboundMessageId, inboundText,
      organizationId: organizationId || null,
    });
  } catch (err) {
    // Tenant failures complete the job (no retry); everything else retries
    // per BullMQ policy — and failures are NEVER charged (ledger below runs
    // only on success).
    if (err?.code === 'tenant-mismatch' || err?.skipRetry) {
      console.error(`[agentQueue] refused cross-org run at execution: ${err.message}`);
      return { status: 'refused-tenant-mismatch', runId: null };
    }
    throw err;
  }
  if (!result || result.skipped) return { ...(result || { skipped: true }), runId: null };

  // Charge the successful run (Phase 8 recordAiUsage: atomic debit + ledger,
  // idempotent on the inbound message key).
  if (organizationId && inboundMessageId) {
    try {
      const { rows: tr } = await pool.query(
        `SELECT r.total_input_tokens, r.total_output_tokens, a.llm_model AS model
           FROM coexistence.agent_runs r
           LEFT JOIN coexistence.agents a ON a.id = r.agent_id
          WHERE r.id = $1`,
        [result.runId]
      );
      const { recordAiUsage } = require('../billing/quotas');
      const { RUN_COST: COST } = require('../ai/qualification');
      await recordAiUsage(pool, {
        organizationId, userId: null, agentId, contactNumber, inboundMessageId,
        model: tr[0]?.model || null,
        tokensIn: tr[0]?.total_input_tokens || 0,
        tokensOut: tr[0]?.total_output_tokens || 0,
        costCredits: COST,
      });
    } catch (usageErr) {
      console.error('[agentQueue] run usage ledger failed:', usageErr.message);
    }
  }

  // Lead-qualification step (Phase 9): only for agents opted in via
  // qualify_leads, in the same tenant context. Eligibility, validation,
  // ledger, and the lead-qualified emit all live inside runQualification.
  let qualificationId = null;
  if (organizationId && inboundMessageId) {
    try {
      const { rows: ag } = await pool.query(
        `SELECT qualify_leads FROM coexistence.agents WHERE id = $1`, [agentId]
      );
      if (ag[0]?.qualify_leads) {
        const { rows: conv } = await pool.query(
          `SELECT id, wa_number FROM coexistence.conversations
            WHERE organization_id = $1 AND contact_number = $2
            ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
          [organizationId, contactNumber]
        );
        let waNumber = conv[0]?.wa_number || null;
        if (!waNumber) {
          const { rows: acc } = await pool.query(
            `SELECT display_phone_number FROM coexistence.whatsapp_accounts wa
              JOIN coexistence.agents a ON a.wa_account_id = wa.id
             WHERE a.id = $1`,
            [agentId]
          );
          waNumber = (acc[0]?.display_phone_number || '').replace(/\D/g, '') || null;
        }
        if (waNumber) {
          const { runQualification } = require('../ai/qualification');
          const q = await runQualification(pool, {
            organizationId, agentId,
            conversationId: conv[0]?.id || null,
            waNumber, contactNumber, inboundMessageId, agentRunId: result.runId,
          });
          qualificationId = q?.qualification?.id || null;
        }
      }
    } catch (qErr) {
      // Qualification is best-effort on top of the completed run: log, keep
      // the run result, never fail the job over it.
      console.error('[agentQueue] qualification step failed:', qErr.message);
    }
  }

  return { ...result, qualificationId };
}

function startAgentWorker() {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
  });

  worker.on('completed', (job, result) => {
    const r = result || {};
    console.log(`[agentQueue] agent=${job.data?.agentId} contact=${job.data?.contactNumber} status=${r.status} run=${r.runId}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[agentQueue] agent=${job?.data?.agentId} contact=${job?.data?.contactNumber} failed (attempt ${job?.attemptsMade}/${ATTEMPTS}): ${err?.message}`);
  });

  queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  queueEvents.on('error', err => console.error('[agentQueue] events error:', err.message));

  console.log(`[agentQueue] worker started, concurrency=${CONCURRENCY}, attempts=${ATTEMPTS}`);
  return worker;
}

/**
 * Enqueue an agent run. The jobId pins it to (agent, contact) so a flood of
 * messages from the same number doesn't fan out into parallel runs that step
 * over each other.
 */
async function enqueueAgentRun({ agentId, contactNumber, inboundMessageId, inboundText, organizationId }) {
  await agentQueue.add(
    'run',
    { agentId, contactNumber, inboundMessageId, inboundText, organizationId: organizationId || null },
    {
      jobId: `agent-${agentId}-${contactNumber}-${inboundMessageId || Date.now()}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 200, age: 3600 },
      removeOnFail: { count: 500, age: 86400 },
    },
  );
}

async function shutdownAgentQueue() {
  try {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    await agentQueue.close();
    await connection.quit();
  } catch (err) {
    console.error('[agentQueue] shutdown error:', err.message);
  }
}

module.exports = { agentQueue, startAgentWorker, enqueueAgentRun, shutdownAgentQueue, processJob };
