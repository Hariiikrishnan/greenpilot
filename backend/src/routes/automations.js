// Green Pilot canonical automation API (Phase 10: /api/v1/automations/*).
//
// Thin org-scoped layer over src/automation/service.js (shared with the
// legacy /chatbots routes — one implementation, two namespaces). Management
// writes require the chatbot-builder page grant (existing permission model);
// reads require membership (resolveTenant upstream). Test runs simulate all
// side effects (no customer messages, no quota, no writes).

const { Router } = require('express');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const { requirePermission } = require('../middleware/access');
const svc = require('../automation/service');

const router = Router();

function safeError(err) {
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 500 ? 'Automation request failed' : (err.message || 'Automation request failed');
  return { status, body: { error: message } };
}

async function requireAutomation(req, res) {
  const row = await svc.assertAutomationAccess(pool, req, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Automation not found' });
    return null;
  }
  return row;
}

// GET /automations — list visible
router.get('/automations', requireOrg, async (req, res) => {
  try {
    res.json(await svc.listAutomations(pool, req.org.id));
  } catch (err) {
    console.error('[automations] list error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /automations/:id — single
router.get('/automations/:id', requireOrg, async (req, res) => {
  try {
    const row = await requireAutomation(req, res);
    if (!row) return;
    res.json(svc.automationShape(row));
  } catch (err) {
    console.error('[automations] get error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /automations — create (stamps org)
router.post('/automations', requireOrg, requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const { name, description, status, trigger_type, config } = req.body || {};
    const created = await svc.createAutomation(pool, req.org.id, { name, description, status, trigger_type, config });
    res.status(201).json(created);
  } catch (err) {
    console.error('[automations] create error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// PUT /automations/:id — update (adopts legacy rows)
router.put('/automations/:id', requireOrg, requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const row = await requireAutomation(req, res);
    if (!row) return;
    await svc.adoptAutomationOrg(pool, row, req.org.id);
    const { name, description, status, trigger_type, config } = req.body || {};
    res.json(await svc.updateAutomation(pool, row, { name, description, status, trigger_type, config }));
  } catch (err) {
    console.error('[automations] update error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /automations/:id/enable | /disable — status flip without touching config
for (const [path, status] of [['/automations/:id/enable', 'active'], ['/automations/:id/disable', 'inactive']]) {
  router.post(path, requireOrg, requirePermission('chatbot-builder'), async (req, res) => {
    try {
      const row = await requireAutomation(req, res);
      if (!row) return;
      await svc.adoptAutomationOrg(pool, row, req.org.id);
      res.json(await svc.updateAutomation(pool, row, { status }));
    } catch (err) {
      console.error('[automations] enable/disable error:', err.message);
      const { status: code, body } = safeError(err);
      res.status(code).json(body);
    }
  });
}

// POST /automations/:id/duplicate — disabled copy in the acting org
router.post('/automations/:id/duplicate', requireOrg, requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const src = await requireAutomation(req, res);
    if (!src) return;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, organization_id)
       VALUES ($1,$2,'inactive',$3,$4,$5)
       RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
      [`${src.name} (copy)`, src.description, src.trigger_type,
        JSON.stringify(src.config || {}), src.organization_id || req.org.id]
    );
    res.status(201).json(svc.automationShape(rows[0]));
  } catch (err) {
    console.error('[automations] duplicate error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// DELETE /automations/:id
router.delete('/automations/:id', requireOrg, requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const row = await requireAutomation(req, res);
    if (!row) return;
    await pool.query('DELETE FROM coexistence.chatbots WHERE id = $1', [row.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[automations] delete error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /automations/:id/executions — history (delegates to the same scoped
// query as the legacy viewer; keeps one implementation).
router.get('/automations/:id/executions', requireOrg, async (req, res) => {
  try {
    const row = await requireAutomation(req, res);
    if (!row) return;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status;
    const params = [row.id, req.org.id];
    let idx = 3;
    let extra = '';
    if (statusFilter && statusFilter !== 'all') {
      extra += ` AND e.status = $${idx++}`;
      params.push(statusFilter);
    }
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM coexistence.automation_executions e
        WHERE e.automation_id = $1 AND e.organization_id = $2${extra}`,
      params
    );
    const total = parseInt(countRows[0].n, 10);
    const { rows } = await pool.query(
      `SELECT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data,
              e.contact_number, e.event_id, e.depth, e.test_mode,
              e.started_at, e.completed_at, e.error_message, e.created_at
         FROM coexistence.automation_executions e
        WHERE e.automation_id = $1 AND e.organization_id = $2${extra}
        ORDER BY e.started_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );
    res.json({ executions: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[automations] executions error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /automations/:id/test-run — safe manual run (Step 23).
// Body: { contactNumber?, waNumber?, messageText? }. Creates a test_mode
// execution and walks it SYNCHRONOUSLY with all side effects simulated:
// no WhatsApp sends, no AI/quota consumption, no CRM writes. Returns the
// execution + steps so the builder can render the trace.
router.post('/automations/:id/test-run', requireOrg, requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const row = await requireAutomation(req, res);
    if (!row) return;
    const { executeAutomation } = require('../engine/automationEngine');
    const client = await pool.connect();
    try {
      const waNumber = String(req.body?.waNumber || '').replace(/\D/g, '') || 'test-wa';
      const contactNumber = String(req.body?.contactNumber || '').replace(/\D/g, '') || 'test-contact';
      const messageText = String(req.body?.messageText || 'Test message');
      const config = row.config || {};
      const trigger = (config.nodes || []).find((n) => n && n.type === 'trigger');
      const context = {
        contact_number: contactNumber,
        message_body: messageText,
        message_type: 'text',
        trigger_type: trigger?.triggerKind || 'test',
        organization_id: req.org.id,
        organizationId: req.org.id,
        automationId: row.id,
        visitedAutomationIds: [],
        depth: 0,
        test_mode: true,
        testMode: true,
        allowDuplicateExecution: true, // every manual run walks fresh
        trigger_data: {
          message_id: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          wa_number: waNumber,
          contact_number: contactNumber,
        },
        contact: { contact_number: contactNumber, tags: [], custom_fields: {} },
        field_defs: [],
      };
      const execution = await executeAutomation(client, { ...row, organization_id: req.org.id }, context);
      const { rows: steps } = await client.query(
        `SELECT id, execution_id, node_id, node_type, node_name, input_data, output_data,
                status, started_at, completed_at, error_message
           FROM coexistence.automation_execution_steps
          WHERE execution_id = $1 ORDER BY started_at ASC`,
        [execution.id]
      );
      res.json({ execution: { ...execution, test_mode: true }, steps, simulated: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[automations] test-run error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

module.exports = { router };
