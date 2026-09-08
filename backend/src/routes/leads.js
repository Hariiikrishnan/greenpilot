// Green Pilot canonical leads API (Phase 11: /api/v1/leads/*).
//
// Lead ≡ org-owned contact (composite (wa_number, contact_number) identity).
// Every route resolves the lead strictly inside req.org (invisible → 404).
// Status/stage/assignment transitions are atomic (row-locked), audited
// (lead_activities), socket-emitted, and fed to the automation bus.

const { Router } = require('express');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const crm = require('../crm/service');

const router = Router();

function safeError(err) {
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 500 ? 'Lead request failed' : (err.message || 'Lead request failed');
  return { status, body: { error: message, ...(err.code ? { code: err.code } : {}) } };
}

// GET /leads — paginated, filterable list (member-visible).
router.get('/leads', requireOrg, async (req, res) => {
  try {
    const { search, status, stageId, assignedUserId, qualification, page, limit } = req.query;
    res.json(await crm.listLeads(pool, req.org.id, {
      search, status, stageId, assignedUserId, qualification, page, limit,
    }));
  } catch (err) {
    console.error('[leads] list error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /leads/by-contact — resolve a lead from inbox context (wa+contact).
router.get('/leads/by-contact', requireOrg, async (req, res) => {
  try {
    const wa = crm.digits(req.query.waNumber);
    const contact = crm.digits(req.query.contactNumber);
    if (!wa || !contact) return res.status(400).json({ error: 'waNumber and contactNumber are required' });
    const lead = await crm.getLeadByContact(pool, req.org.id, wa, contact);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(await crm.enrichLead(pool, req.org.id, crm.leadShape(lead)));
  } catch (err) {
    console.error('[leads] by-contact error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /leads/:id — full lead view (enriched).
router.get('/leads/:id', requireOrg, async (req, res) => {
  try {
    const lead = await crm.getLeadById(pool, req.org.id, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const shaped = crm.leadShape(lead);
    const enriched = await crm.enrichLead(pool, req.org.id, shaped);
    // Linked open deals (org-scoped, same contact pair).
    const { rows: deals } = await pool.query(
      `SELECT d.id, d.title, d.stage_id, s.name AS stage_name, d.status, d.value
         FROM coexistence.deals d
         LEFT JOIN coexistence.pipeline_stages s ON s.id = d.stage_id
        WHERE d.contact_wa_number = $1 AND d.contact_number = $2 AND d.organization_id = $3
        ORDER BY d.updated_at DESC LIMIT 20`,
      [shaped.waNumber, shaped.contactNumber, req.org.id]
    );
    // WhatsApp thread (org-scoped).
    const { rows: conv } = await pool.query(
      `SELECT id, last_message_at, unread_count FROM coexistence.conversations
        WHERE organization_id = $1 AND wa_number = $2 AND contact_number = $3
        ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
      [req.org.id, shaped.waNumber, shaped.contactNumber]
    );
    res.json({ ...enriched, deals, conversation: conv[0] || null });
  } catch (err) {
    console.error('[leads] get error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /leads — explicit create (409 when the pair already exists).
router.post('/leads', requireOrg, async (req, res) => {
  try {
    const { waNumber, contactNumber, name, assignedUserId } = req.body || {};
    const lead = await crm.createLead(pool, req.org.id,
      { waNumber, contactNumber, name, assignedUserId }, req.user?.id);
    res.status(201).json(lead);
  } catch (err) {
    console.error('[leads] create error:', err.message);
    const { status, body } = safeError(err);
    if (err.code === 'lead-exists' && err.details?.leadId) {
      res.status(status).json({ ...body, leadId: err.details.leadId });
      return;
    }
    res.status(status).json(body);
  }
});

// DELETE /leads/:id — removes the CRM row (chat history is retained).
router.delete('/leads/:id', requireOrg, async (req, res) => {
  try {
    const ok = await crm.deleteLead(pool, req.org.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[leads] delete error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// PATCH /leads/:id/status — canonical status transition.
router.patch('/leads/:id/status', requireOrg, async (req, res) => {
  try {
    const { status } = req.body || {};
    const r = await crm.setLeadStatus(pool, req.org.id, req.params.id, status, req.user?.id);
    res.json({ ...r.lead, changed: r.changed, previous: r.previous || null });
  } catch (err) {
    console.error('[leads] status error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// PATCH /leads/:id/stage — canonical stage move (null clears).
router.patch('/leads/:id/stage', requireOrg, async (req, res) => {
  try {
    const { stageId } = req.body || {};
    const r = await crm.setLeadStage(pool, req.org.id, req.params.id,
      stageId === null ? null : stageId, req.user?.id);
    res.json({ ...r.lead, changed: r.changed });
  } catch (err) {
    console.error('[leads] stage error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// PATCH /leads/:id/assign — team assignment (null clears; assignee must be
// an active member of the organization).
router.patch('/leads/:id/assign', requireOrg, async (req, res) => {
  try {
    const { userId } = req.body || {};
    const r = await crm.assignLead(pool, req.org.id, req.params.id, userId ?? null, req.user?.id);
    res.json({ ...r.lead, changed: r.changed });
  } catch (err) {
    console.error('[leads] assign error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /leads/:id/messages — paginated messages for lead (org-scoped).
router.get('/leads/:id/messages', requireOrg, async (req, res) => {
  try {
    const raw = await crm.getLeadById(pool, req.org.id, req.params.id);
    if (!raw) return res.status(404).json({ error: 'Lead not found' });
    const lead = crm.leadShape(raw);

    const { page = '1', limit = '50', search = '', direction = 'all' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const params = [lead.waNumber, lead.contactNumber, req.org.id];
    let paramIdx = 4;
    const conditions = [
      'wa_number = $1',
      'contact_number = $2',
      '(organization_id = $3 OR organization_id IS NULL)',
      `message_type <> 'status'`,
    ];

    const trimmedSearch = typeof search === 'string' ? search.trim().slice(0, 200) : '';
    if (trimmedSearch) {
      conditions.push(`COALESCE(message_body, '') ILIKE $${paramIdx}`);
      params.push(`%${trimmedSearch}%`);
      paramIdx++;
    }

    if (direction === 'incoming' || direction === 'outgoing') {
      conditions.push(`direction = $${paramIdx}`);
      params.push(direction);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM coexistence.chat_history WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.chat_history
       WHERE ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    const ids = rows.map(r => r.message_id).filter(Boolean);
    const reactionsByMsg = {};
    if (ids.length > 0) {
      const { rows: rx } = await pool.query(
        `SELECT target_message_id, direction, emoji
         FROM coexistence.message_reactions
         WHERE target_message_id = ANY($1)`,
        [ids]
      );
      for (const r of rx) {
        (reactionsByMsg[r.target_message_id] ||= []).push({ emoji: r.emoji, direction: r.direction });
      }
    }

    res.json({
      messages: rows
        .map(({ raw_payload, ...m }) => ({
          ...m,
          reactions: reactionsByMsg[m.message_id] || [],
        }))
        .reverse(),
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    });
  } catch (err) {
    console.error('[leads] messages error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /leads/:id/messages — send outbound message to a lead (org-scoped).
router.post('/leads/:id/messages', requireOrg, async (req, res) => {
  try {
    const raw = await crm.getLeadById(pool, req.org.id, req.params.id);
    if (!raw) return res.status(404).json({ error: 'Lead not found' });
    const lead = crm.leadShape(raw);

    const { text, type = 'text', media, template, contextMessageId } = req.body || {};
    if (!text && !media && !template) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const { sendWhatsAppMessage } = require('../services/whatsappMessaging');
    const result = await sendWhatsAppMessage({
      organizationId: req.org.id,
      fromNumber: lead.waNumber,
      toNumber: lead.contactNumber,
      type,
      text,
      media,
      template,
      contextMessageId,
      db: pool,
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('[leads] send message error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

module.exports = { router };

