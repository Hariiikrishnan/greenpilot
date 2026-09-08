// Green Pilot automation execution queue (Phase 10).
//
// Webhook/service paths only CREATE executions + enqueue (fast, under Meta's
// 20s ceiling); this worker walks the graph. Every job carries
// { organizationId, automationId, executionId, eventId, resumeNodeId? } and
// the worker revalidates all of it — queue payloads are never trusted.
//
// Delayed (delay-node) resumes requeue the SAME execution with a BullMQ
// delay; tenant context travels in the ids and is revalidated on wake.

const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedisSdk = require('ioredis');
// CJS/default normalization (same as the send queue / LLM adapters).
/** @type {any} */
const IORedis = IORedisSdk && IORedisSdk.default ? IORedisSdk.default : IORedisSdk;
const pool = require('../db');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'greenpilot-automation';
const CONCURRENCY = parseInt(process.env.AUTOMATION_QUEUE_CONCURRENCY || '4', 10);
const ATTEMPTS = parseInt(process.env.AUTOMATION_QUEUE_ATTEMPTS || '3', 10);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', (err) => console.error('[automationQueue] redis error:', err.message));

const automationQueue = new Queue(QUEUE_NAME, { connection });

let worker = null;
let queueEvents = null;

function emitLifecycle(organizationId, name, execution) {
  try {
    require('../realtime/emitter').emitAutomationEvent(organizationId, name, execution);
  } catch (err) {
    console.error('[automationQueue] realtime emit failed:', err.message);
  }
}

// Hydrate the walk context for an execution (org-scoped contact +
// qualification snapshots for condition evaluation).
async function hydrateContext(client, execution, triggerData) {
  const orgId = execution.organization_id;
  const context = {
    contact_number: execution.contact_number,
    message_body: triggerData?.message_body || triggerData?.body || '',
    message_type: triggerData?.message_type || null,
    trigger_type: execution.trigger_type,
    trigger_data: triggerData || {},
    organization_id: orgId,
    organizationId: orgId,
    automationId: execution.automation_id,
    visitedAutomationIds: [],
    depth: execution.depth || 0,
    test_mode: false,
    testMode: false,
    asyncDelay: true, // worker walks suspend on delay nodes (durable requeue)
    conversation_id: triggerData?.conversation_id || triggerData?.conversationId || null,
  };
  const waNumber = triggerData?.wa_number || triggerData?.waNumber || null;
  const contactNumber = execution.contact_number;
  if (waNumber && contactNumber) {
    try {
      const params = orgId ? [waNumber, contactNumber, orgId] : [waNumber, contactNumber];
      const scope = orgId
        ? 'AND organization_id = $3'
        : 'AND organization_id IS NULL';
      const { rows } = await client.query(
        `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
          WHERE wa_number = $1 AND contact_number = $2 ${scope} LIMIT 1`,
        params
      );
      if (rows[0]) {
        context.contact = {
          name: rows[0].name,
          profile_name: rows[0].profile_name,
          contact_number: contactNumber,
          tags: rows[0].tags || [],
          custom_fields: rows[0].custom_fields || {},
        };
      }
      const { rows: qRows } = await client.query(
        `SELECT status, score, intent, summary FROM coexistence.lead_qualifications
          WHERE organization_id ${orgId ? '= $3' : 'IS NULL'}
            AND wa_number = $1 AND contact_number = $2
          ORDER BY evaluated_at DESC LIMIT 1`,
        orgId ? [waNumber, contactNumber, orgId] : [waNumber, contactNumber]
      );
      if (qRows[0]) {
        context.qualification = {
          status: qRows[0].status,
          score: qRows[0].score,
          intent: qRows[0].intent,
          summary: qRows[0].summary,
        };
      }
    } catch (e) { /* hydration is best-effort; conditions fail closed without it */ }
  }
  try {
    const { rows: fdRows } = await client.query('SELECT id, name FROM coexistence.contact_field_definitions');
    context.field_defs = fdRows;
  } catch { context.field_defs = []; }
  return context;
}

async function processJob(job) {
  const { organizationId, automationId, executionId, eventId, resumeNodeId } = job.data || {};
  if (!organizationId || !automationId || !executionId) {
    throw new Error('automation job missing tenant context (organizationId/automationId/executionId)');
  }
  const {
    walkFrom, updateExecutionStatus,
  } = require('../engine/automationEngine');

  // Revalidate everything (Step 13): automation visible + active in this org,
  // execution belongs to this org and is still runnable.
  const { rows: autoRows } = await pool.query(
    `SELECT id, name, status, config, organization_id FROM coexistence.chatbots WHERE id = $1`,
    [automationId]
  );
  const automation = autoRows[0];
  if (!automation ||
      (automation.organization_id && String(automation.organization_id) !== String(organizationId))) {
    await pool.query(
      `UPDATE coexistence.automation_executions SET status = 'error',
         error_message = 'Automation not found in this organization', completed_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status IN ('queued','running')`,
      [executionId, organizationId]
    );
    return { status: 'refused-foreign-automation', executionId };
  }
  if (automation.status !== 'active') {
    await pool.query(
      `UPDATE coexistence.automation_executions SET status = 'cancelled',
         error_message = 'Automation is not active', completed_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status IN ('queued','running')`,
      [executionId, organizationId]
    );
    return { status: 'cancelled-inactive', executionId };
  }
  const { rows: execRows } = await pool.query(
    `SELECT * FROM coexistence.automation_executions WHERE id = $1 AND organization_id = $2`,
    [executionId, organizationId]
  );
  const execution = execRows[0];
  if (!execution) {
    return { status: 'refused-foreign-execution', executionId };
  }
  if (!['queued', 'running'].includes(execution.status)) {
    return { status: `already-${execution.status}`, executionId }; // idempotent redelivery
  }

  const client = await pool.connect();
  try {
    const config = automation.config || {};
    const nodes = config.nodes || [];
    const edges = config.edges || [];
    const triggerNode = nodes.find((n) => n && n.type === 'trigger');
    if (!triggerNode) {
      await updateExecutionStatus(client, executionId, 'error', 'No trigger node in automation');
      emitLifecycle(organizationId, 'automation-failed', { automationId, executionId, status: 'error' });
      return { status: 'error', executionId };
    }
    // trigger_data is JSONB — pg already parses it. Parse defensively for
    // legacy TEXT rows without ever blanking a valid object.
    let triggerData = {};
    try {
      const raw = execution.trigger_data;
      triggerData = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      if (!triggerData || typeof triggerData !== 'object') triggerData = {};
    } catch { triggerData = {}; }
    const context = await hydrateContext(client, execution, triggerData);

    await client.query(
      `UPDATE coexistence.automation_executions SET status = 'running', started_at = NOW() WHERE id = $1`,
      [executionId]
    );
    emitLifecycle(organizationId, 'automation-started', { automationId, executionId, status: 'running' });

    let result;
    if (resumeNodeId) {
      result = await walkFrom(client, executionId, nodes, edges, resumeNodeId, context, new Set([triggerNode.id]));
    } else {
      const triggerEdges = edges.filter((e) => e.from === triggerNode.id);
      const startNodeId = triggerEdges.length > 0 ? triggerEdges[0].to : null;
      // Log the trigger step for history completeness.
      const { logStep } = require('../engine/automationEngine');
      await logStep(client, executionId, triggerNode,
        { eventId, eventType: execution.trigger_type }, { fired: true }, 'success');
      result = await walkFrom(client, executionId, nodes, edges, startNodeId, context, new Set([triggerNode.id]));
    }

    if (result.paused) {
      emitLifecycle(organizationId, 'automation-started', { automationId, executionId, status: 'paused' });
      return { status: 'paused', executionId };
    }
    if (result.delayed) {
      // Durable suspension: same execution resumes at the next node after the
      // BullMQ delay. Tenant context travels in ids, revalidated on wake.
      // Called via module.exports so tests can capture the transport without
      // Redis (production behavior identical).
      if (result.resumeNodeId) {
        await module.exports.enqueueAutomationRun({
          organizationId: String(organizationId), automationId, executionId, eventId,
          resumeNodeId: result.resumeNodeId,
        }, { delayMs: result.delayMs });
        return { status: 'delayed', executionId, delayMs: result.delayMs };
      }
      await updateExecutionStatus(client, executionId, 'success');
      emitLifecycle(organizationId, 'automation-completed', { automationId, executionId, status: 'success' });
      return { status: 'success', executionId };
    }
    await updateExecutionStatus(client, executionId, 'success');
    emitLifecycle(organizationId, 'automation-completed', { automationId, executionId, status: 'success' });
    return { status: 'success', executionId };
  } catch (err) {
    try {
      const { updateExecutionStatus: ues } = require('../engine/automationEngine');
      await ues(client, executionId, 'error', String(err.message || err).slice(0, 1000));
    } catch { /* status write failed — job still reports */ }
    emitLifecycle(organizationId, 'automation-failed', { automationId, executionId, status: 'error' });
    throw err; // BullMQ retry policy applies (transient); terminal states complete via revalidation
  } finally {
    client.release();
  }
}

function startAutomationWorker() {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
  });
  worker.on('completed', (job, result) => {
    console.log(`[automationQueue] automation=${job.data?.automationId} execution=${job.data?.executionId} → ${result?.status}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[automationQueue] automation=${job?.data?.automationId} execution=${job?.data?.executionId} failed attempt=${job?.attemptsMade}/${ATTEMPTS}: ${err.message}`);
  });
  queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  queueEvents.on('error', (err) => console.error('[automationQueue] events error:', err.message));
  console.log(`[automationQueue] worker started, concurrency=${CONCURRENCY}, attempts=${ATTEMPTS}`);
  return worker;
}

// Enqueue one execution walk. Idempotency lives in the execution row
// (UNIQUE org/automation/event); the jobId pins redeliveries to the same
// BullMQ job while it is still queued.
/**
 * @param {{organizationId: string, automationId: number, executionId: number,
 *   eventId?: string|null, resumeNodeId?: string|null}} job
 * @param {{delayMs?: number}} [opts]
 */
async function enqueueAutomationRun({ organizationId, automationId, executionId, eventId, resumeNodeId }, opts = {}) {
  if (!organizationId || !automationId || !executionId) {
    throw new Error('enqueueAutomationRun requires organizationId, automationId, executionId');
  }
  const suffix = resumeNodeId ? `-resume-${String(resumeNodeId).slice(0, 24)}` : '';
  const addOpts = {
    jobId: `auto-${executionId}${suffix}`,
    attempts: ATTEMPTS,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 1000, age: 86400 },
  };
  if (opts.delayMs && opts.delayMs > 0) addOpts.delay = Math.round(opts.delayMs);
  await automationQueue.add('walk', {
    organizationId: String(organizationId), automationId, executionId,
    eventId: eventId || null, resumeNodeId: resumeNodeId || null,
  }, addOpts);
}

async function shutdownAutomationQueue() {
  try {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    await automationQueue.close();
    await connection.quit();
  } catch (err) {
    console.error('[automationQueue] shutdown error:', err.message);
  }
}

module.exports = {
  automationQueue, startAutomationWorker, enqueueAutomationRun, shutdownAutomationQueue, processJob,
};
