const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const {
  ConfigError,
  validateAutomationConfig,
  assertAutomationAccess,
  adoptAutomationOrg,
  automationShape,
  listAutomations,
} = require('../automation/service');

// Phase 10: tenant-bound automation CRUD. Response shapes are unchanged
// (the builder UI consumes them as-is); only the data each caller may see
// changed. sanitizeToLinear (which silently deleted condition/delay/action
// nodes on every save) is replaced by validateAutomationConfig — approved
// nodes are KEPT, unsupported types fail loudly with 400.

// Tenant gate for every :id route: invisible reads as 404 (no cross-tenant
// probing). requirePermission('chatbot-builder') still gates mutations.
async function requireChatbot(req, res) {
  const row = await assertAutomationAccess(pool, req, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Chatbot not found' });
    return null;
  }
  return row;
}

// Strict execution scope (mirrors scope.js assertOrgRow): org callers see
// only their org rows; legacy callers see only legacy rows.
function executionScope(orgId, nextParam) {
  if (orgId) return { clause: `AND e.organization_id = $${nextParam}`, params: [orgId] };
  return { clause: `AND e.organization_id IS NULL`, params: [] };
}

// GET /chatbots — list visible automations
router.get('/chatbots', async (req, res) => {
  try {
    res.json((await listAutomations(pool, req.org?.id || null)).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      status: a.status,
      trigger_type: a.trigger_type,
      config: a.config,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })));
  } catch (err) {
    console.error('[chatbots] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch chatbots' });
  }
});

// GET /chatbots/:id — single chatbot
router.get('/chatbots/:id', async (req, res) => {
  try {
    const row = await requireChatbot(req, res);
    if (!row) return;
    res.json(automationShape(row));
  } catch (err) {
    console.error('[chatbots] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch chatbot' });
  }
});

// POST /chatbots — create (stamps the acting org)
router.post('/chatbots', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const { name, description, status, trigger_type, config } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    let clean = null;
    if (config !== undefined) {
      try {
        clean = validateAutomationConfig(config);
      } catch (e) {
        if (e instanceof ConfigError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    const trigger = (clean?.nodes || []).find((n) => n.type === 'trigger');
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name.trim(), description || null, status || 'draft',
        trigger_type || trigger?.triggerKind || 'keyword',
        JSON.stringify(clean || {}), req.org?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatbots] create error:', err.message);
    res.status(500).json({ error: 'Failed to create chatbot' });
  }
});

// PUT /chatbots/:id — update (adopts legacy rows into the acting org)
router.put('/chatbots/:id', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const row = await requireChatbot(req, res);
    if (!row) return;
    await adoptAutomationOrg(pool, row, req.org?.id || null);
    const { name, description, status, trigger_type, config } = req.body;
    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    let cleanJson = null;
    if (config !== undefined) {
      try {
        cleanJson = JSON.stringify(validateAutomationConfig(config));
      } catch (e) {
        if (e instanceof ConfigError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    const { rows } = await pool.query(
      `UPDATE coexistence.chatbots SET
        name = COALESCE($1, name),
        description = $2,
        status = COALESCE($3, status),
        trigger_type = COALESCE($4, trigger_type),
        config = COALESCE($5, config),
        updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name ? name.trim() : null, description, status, trigger_type, cleanJson, row.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[chatbots] update error:', err.message);
    res.status(500).json({ error: 'Failed to update chatbot' });
  }
});

// POST /chatbots/:id/duplicate — clone an automation. The copy is always
// created DISABLED ('inactive') so it can't fire until reviewed/enabled.
router.post('/chatbots/:id/duplicate', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const src = await requireChatbot(req, res);
    if (!src) return;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, organization_id)
       VALUES ($1,$2,'inactive',$3,$4,$5)
       RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
      [`${src.name} (copy)`, src.description, src.trigger_type,
        JSON.stringify(src.config || {}), src.organization_id || req.org?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatbots] duplicate error:', err.message);
    res.status(500).json({ error: 'Failed to duplicate chatbot' });
  }
});

// GET /chatbots/:id/export — portable automation file (id/timestamps stripped).
router.get('/chatbots/:id/export', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const c = await requireChatbot(req, res);
    if (!c) return;
    res.json({
      type: 'greenpilot.automation',
      version: 1,
      automation: { name: c.name, description: c.description, trigger_type: c.trigger_type, config: c.config || {} },
    });
  } catch (err) {
    console.error('[chatbots] export error:', err.message);
    res.status(500).json({ error: 'Failed to export chatbot' });
  }
});

// POST /chatbots/import — create a new automation from an export file. Always
// lands DISABLED ('inactive') so it can't fire until reviewed/enabled.
router.post('/chatbots/import', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const payload = req.body || {};
    if ((payload.type !== 'greenpilot.automation' && payload.type !== 'forgechat.automation') || !payload.automation || !payload.automation.name) {
      return res.status(400).json({ error: 'That file is not a Green Pilot automation export.' });
    }
    const a = payload.automation;
    let clean;
    try {
      clean = validateAutomationConfig(a.config || {});
    } catch (e) {
      if (e instanceof ConfigError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const trigger = (clean.nodes || []).find((n) => n.type === 'trigger');
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, organization_id)
       VALUES ($1,$2,'inactive',$3,$4,$5)
       RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
      [`${String(a.name).trim()} (imported)`.slice(0, 200), a.description || null,
        a.trigger_type || trigger?.triggerKind || 'keyword',
        JSON.stringify(clean), req.org?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatbots] import error:', err.message);
    res.status(500).json({ error: 'Failed to import chatbot' });
  }
});

// DELETE /chatbots/:id
router.delete('/chatbots/:id', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const row = await requireChatbot(req, res);
    if (!row) return;
    await pool.query('DELETE FROM coexistence.chatbots WHERE id = $1', [row.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[chatbots] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete chatbot' });
  }
});

// GET /chatbots/:id/executions — paginated list of executions for an automation
router.get('/chatbots/:id/executions', async (req, res) => {
  try {
    const row = await requireChatbot(req, res);
    if (!row) return;
    const automationId = row.id;
    const orgId = req.org?.id || null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Filters
    const statusFilter = req.query.status;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const messageStatus = req.query.messageStatus;

    let whereClause = 'WHERE e.automation_id = $1';
    const params = [automationId];
    let paramIdx = 2;

    const scope = executionScope(orgId, paramIdx);
    whereClause += ` ${scope.clause}`;
    params.push(...scope.params);
    paramIdx += scope.params.length;

    if (statusFilter && statusFilter !== 'all') {
      whereClause += ` AND e.status = $${paramIdx}`;
      params.push(statusFilter);
      paramIdx++;
    }

    if (startDate) {
      whereClause += ` AND e.started_at >= $${paramIdx}`;
      params.push(new Date(startDate).toISOString());
      paramIdx++;
    }

    if (endDate) {
      whereClause += ` AND e.started_at <= $${paramIdx}`;
      params.push(new Date(endDate).toISOString());
      paramIdx++;
    }

    // Message status filter — find executions where any step has the given wa_message_status
    let joinClause = '';
    if (messageStatus && messageStatus !== 'all') {
      joinClause = `JOIN coexistence.automation_execution_steps s ON s.execution_id = e.id AND s.wa_message_status = $${paramIdx}`;
      params.push(messageStatus);
      paramIdx++;
    }

    const countQuery = messageStatus && messageStatus !== 'all'
      ? `SELECT COUNT(DISTINCT e.id) FROM coexistence.automation_executions e ${joinClause} ${whereClause}`
      : `SELECT COUNT(*) FROM coexistence.automation_executions e ${whereClause}`;

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataQuery = messageStatus && messageStatus !== 'all'
      ? `SELECT DISTINCT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data, e.contact_number,
              e.event_id, e.depth, e.test_mode,
              e.started_at, e.completed_at, e.error_message, e.created_at
       FROM coexistence.automation_executions e
       ${joinClause}
       ${whereClause}
       ORDER BY e.started_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`
      : `SELECT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data, e.contact_number,
              e.event_id, e.depth, e.test_mode,
              e.started_at, e.completed_at, e.error_message, e.created_at
       FROM coexistence.automation_executions e
       ${whereClause}
       ORDER BY e.started_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

    const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

    res.json({
      executions: rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[chatbots] GET /chatbots/:id/executions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// GET /executions/:id — single execution with all steps (execution org-scoped)
router.get('/executions/:id', async (req, res) => {
  try {
    const orgId = req.org?.id || null;
    const scope = executionScope(orgId, 2);
    const { rows: execRows } = await pool.query(
      `SELECT id, automation_id, status, trigger_type, trigger_data, contact_number,
              event_id, depth, test_mode,
              started_at, completed_at, error_message, created_at
       FROM coexistence.automation_executions e
       WHERE e.id = $1 ${scope.clause}`,
      [req.params.id, ...scope.params]
    );
    if (execRows.length === 0) return res.status(404).json({ error: 'Execution not found' });

    const { rows: stepRows } = await pool.query(
      `SELECT id, execution_id, node_id, node_type, node_name, input_data, output_data,
              status, started_at, completed_at, error_message, wa_message_id, wa_message_status, created_at
       FROM coexistence.automation_execution_steps
       WHERE execution_id = $1
       ORDER BY started_at ASC`,
      [req.params.id]
    );

    res.json({ ...execRows[0], steps: stepRows });
  } catch (err) {
    console.error('[chatbots] GET /executions/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch execution' });
  }
});

// POST /executions/:id/cancel — stop a non-terminal execution. A cancelled
// 'paused' execution will no longer resume when the customer replies (the
// webhook resume only claims rows WHERE status='paused').
router.post('/executions/:id/cancel', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const orgId = req.org?.id || null;
    const scope = executionScope(orgId, 2);
    const { rows: visible } = await pool.query(
      `SELECT id FROM coexistence.automation_executions e WHERE e.id = $1 ${scope.clause}`,
      [req.params.id, ...scope.params]
    );
    if (visible.length === 0) return res.status(404).json({ error: 'Execution not found' });
    const { rows } = await pool.query(
      `UPDATE coexistence.automation_executions
          SET status = 'cancelled',
              completed_at = NOW(),
              error_message = COALESCE(error_message, 'Cancelled by user')
        WHERE id = $1 AND status IN ('running', 'paused', 'queued')
        RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'Execution is already finished — nothing to stop.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[chatbots] cancel execution error:', err.message);
    res.status(500).json({ error: 'Failed to cancel execution' });
  }
});

module.exports = { router };
