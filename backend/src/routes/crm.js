// Green Pilot canonical CRM API (Phase 11: /api/v1/crm/*).
//
// Notes, calls, follow-ups, and the merged activity timeline — all strictly
// org-scoped and lead-bound. Pipelines/stages/deals keep their existing
// routes (now org-scoped in place); this router covers the Tier-2 surfaces
// that previously had no read API at all.

const { Router } = require('express');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const crm = require('../crm/service');

const router = Router();

function safeError(err) {
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 500 ? 'CRM request failed' : (err.message || 'CRM request failed');
  return { status, body: { error: message, ...(err.code ? { code: err.code } : {}) } };
}

function contactParams(req) {
  const waNumber = crm.digits(req.query.waNumber || req.body?.waNumber);
  const contactNumber = crm.digits(req.query.contactNumber || req.body?.contactNumber);
  return { waNumber, contactNumber };
}

// --- Notes ------------------------------------------------------------------------

router.get('/crm/notes', requireOrg, async (req, res) => {
  try {
    const { contactNumber } = contactParams(req);
    if (!contactNumber) return res.status(400).json({ error: 'contactNumber is required' });
    res.json(await crm.listNotes(pool, req.org.id, contactNumber));
  } catch (err) {
    console.error('[crm] notes error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.post('/crm/notes', requireOrg, async (req, res) => {
  try {
    const { waNumber, contactNumber } = contactParams(req);
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber are required' });
    }
    const note = await crm.createNote(pool, req.org.id, waNumber, contactNumber, req.body?.body, req.user?.id);
    res.status(201).json(note);
  } catch (err) {
    console.error('[crm] note create error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.put('/crm/notes/:id', requireOrg, async (req, res) => {
  try {
    res.json(await crm.updateNote(pool, req.org.id, req.params.id, req.body?.body));
  } catch (err) {
    console.error('[crm] note update error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.delete('/crm/notes/:id', requireOrg, async (req, res) => {
  try {
    const ok = await crm.deleteNote(pool, req.org.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[crm] note delete error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// --- Calls --------------------------------------------------------------------------

router.get('/crm/calls', requireOrg, async (req, res) => {
  try {
    const { contactNumber } = contactParams(req);
    if (!contactNumber) return res.status(400).json({ error: 'contactNumber is required' });
    res.json(await crm.listCalls(pool, req.org.id, contactNumber));
  } catch (err) {
    console.error('[crm] calls error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.post('/crm/calls', requireOrg, async (req, res) => {
  try {
    const { waNumber, contactNumber } = contactParams(req);
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber are required' });
    }
    const call = await crm.logCall(pool, req.org.id, waNumber, contactNumber,
      { outcome: req.body?.outcome, notes: req.body?.notes }, req.user?.id);
    res.status(201).json(call);
  } catch (err) {
    console.error('[crm] call log error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.delete('/crm/calls/:id', requireOrg, async (req, res) => {
  try {
    const ok = await crm.deleteCall(pool, req.org.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Call not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[crm] call delete error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// --- Follow-ups -------------------------------------------------------------------------

router.get('/crm/followups', requireOrg, async (req, res) => {
  try {
    const { contactNumber } = contactParams(req);
    if (!contactNumber) return res.status(400).json({ error: 'contactNumber is required' });
    res.json(await crm.listFollowups(pool, req.org.id, contactNumber, {
      status: req.query.status, page: req.query.page, limit: req.query.limit,
    }));
  } catch (err) {
    console.error('[crm] followups error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.post('/crm/followups', requireOrg, async (req, res) => {
  try {
    const { waNumber, contactNumber } = contactParams(req);
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber are required' });
    }
    const fu = await crm.createFollowup(pool, req.org.id, waNumber, contactNumber,
      { dueAt: req.body?.dueAt, assignedTo: req.body?.assignedTo });
    res.status(201).json(fu);
  } catch (err) {
    console.error('[crm] followup create error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.post('/crm/followups/:id/complete', requireOrg, async (req, res) => {
  try {
    res.json(await crm.setFollowupStatus(pool, req.org.id, req.params.id, 'done'));
  } catch (err) {
    console.error('[crm] followup complete error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

router.post('/crm/followups/:id/cancel', requireOrg, async (req, res) => {
  try {
    res.json(await crm.setFollowupStatus(pool, req.org.id, req.params.id, 'cancelled'));
  } catch (err) {
    console.error('[crm] followup cancel error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// --- Activity timeline ----------------------------------------------------------------------

router.get('/crm/activity', requireOrg, async (req, res) => {
  try {
    const { waNumber, contactNumber } = contactParams(req);
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber are required' });
    }
    // Lead must exist in this org (404 otherwise — no cross-tenant timeline).
    const lead = await crm.getLeadByContact(pool, req.org.id, waNumber, contactNumber);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(await crm.getTimeline(pool, req.org.id, waNumber, contactNumber, { limit: req.query.limit }));
  } catch (err) {
    console.error('[crm] activity error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

module.exports = { router };
