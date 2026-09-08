// Green Pilot canonical chats API (Phase 5/6: /api/v1/chats/*).
//
// Every route is authenticated and strictly scoped to req.org (invisible -> 404/empty).
// Provides:
// - GET  /chats: paginated, searchable, sorted by recent activity
// - GET  /chats/:id: conversation detail
// - GET  /chats/:id/messages: paginated message history
// - POST /chats/:id/messages: send outbound message
// - GET  /chats/:id/ai-mode: current AI mode + human takeover state
// - POST /chats/:id/ai-mode: enable/disable AI for a conversation (human takeover)

const { Router } = require('express');
const pool = require('../db');
const { requireOrg } = require('../middleware/tenant');
const { sendWhatsAppMessage } = require('../services/whatsappMessaging');
const { emitConversationUpdated } = require('../realtime/emitter');

const router = Router();

function safeError(err) {
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 500 ? 'Chat request failed' : (err.message || 'Chat request failed');
  return { status, body: { error: message, ...(err.code ? { code: err.code } : {}) } };
}

// GET /chats — paginated list of conversations for acting organization
router.get('/chats', requireOrg, async (req, res) => {
  try {
    const orgId = req.org.id;
    const {
      page = '1',
      limit = '20',
      search = '',
      waNumber,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const params = [orgId];
    const conditions = ['cv.organization_id = $1'];

    if (waNumber) {
      params.push(String(waNumber).replace(/\D/g, ''));
      conditions.push(`regexp_replace(cv.wa_number, '\\D', '', 'g') = $${params.length}`);
    }

    const trimmedSearch = typeof search === 'string' ? search.trim().slice(0, 100) : '';
    if (trimmedSearch) {
      params.push(`%${trimmedSearch}%`);
      const sIdx = params.length;
      conditions.push(`(
        ct.name ILIKE $${sIdx}
        OR ct.profile_name ILIKE $${sIdx}
        OR cv.contact_number ILIKE $${sIdx}
        OR EXISTS (
          SELECT 1 FROM coexistence.chat_history ch_s
          WHERE ch_s.organization_id = cv.organization_id
            AND ch_s.wa_number = cv.wa_number
            AND ch_s.contact_number = cv.contact_number
            AND ch_s.message_body ILIKE $${sIdx}
        )
      )`);
    }

    const whereClause = conditions.join(' AND ');

    // Total count query
    const countRes = await pool.query(
      `SELECT COUNT(*) AS total
       FROM coexistence.conversations cv
       LEFT JOIN coexistence.contacts ct
         ON ct.wa_number = cv.wa_number
        AND ct.contact_number = cv.contact_number
        AND (ct.organization_id = cv.organization_id OR ct.organization_id IS NULL)
       WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.total || 0, 10);

    // List query
    const { rows } = await pool.query(
      `SELECT
         cv.id,
         cv.organization_id,
         cv.whatsapp_account_id,
         cv.wa_number,
         cv.contact_number,
         cv.last_message_at,
         cv.unread_count,
         cv.updated_at,
         COALESCE(ct.name, ct.profile_name) AS contact_name,
         ct.tags,
         ct.assigned_user_id,
         u.display_name AS assigned_user_name,
         (
           SELECT ch.message_body
           FROM coexistence.chat_history ch
           WHERE ch.wa_number = cv.wa_number
             AND ch.contact_number = cv.contact_number
             AND (ch.organization_id = cv.organization_id OR ch.organization_id IS NULL)
             AND ch.message_type <> 'status'
           ORDER BY ch.timestamp DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT ch.message_type
           FROM coexistence.chat_history ch
           WHERE ch.wa_number = cv.wa_number
             AND ch.contact_number = cv.contact_number
             AND (ch.organization_id = cv.organization_id OR ch.organization_id IS NULL)
             AND ch.message_type <> 'status'
           ORDER BY ch.timestamp DESC
           LIMIT 1
         ) AS last_message_type,
         (
           SELECT ch.direction
           FROM coexistence.chat_history ch
           WHERE ch.wa_number = cv.wa_number
             AND ch.contact_number = cv.contact_number
             AND (ch.organization_id = cv.organization_id OR ch.organization_id IS NULL)
             AND ch.message_type <> 'status'
           ORDER BY ch.timestamp DESC
           LIMIT 1
         ) AS last_message_direction,
         (
           SELECT ch.status
           FROM coexistence.chat_history ch
           WHERE ch.wa_number = cv.wa_number
             AND ch.contact_number = cv.contact_number
             AND (ch.organization_id = cv.organization_id OR ch.organization_id IS NULL)
             AND ch.message_type <> 'status'
           ORDER BY ch.timestamp DESC
           LIMIT 1
         ) AS last_message_status
       FROM coexistence.conversations cv
       LEFT JOIN coexistence.contacts ct
         ON ct.wa_number = cv.wa_number
        AND ct.contact_number = cv.contact_number
        AND (ct.organization_id = cv.organization_id OR ct.organization_id IS NULL)
       LEFT JOIN coexistence.forgecrm_users u
         ON u.id = ct.assigned_user_id
       WHERE ${whereClause}
       ORDER BY cv.last_message_at DESC NULLS LAST, cv.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limitNum, offset]
    );

    const mapped = rows.map(r => ({
      ...r,
      tags: r.tags || [],
      unread_count: Number(r.unread_count) || 0,
    }));
    res.json({
      chats: mapped,
      conversations: mapped,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    });
  } catch (err) {
    console.error('[chats] list error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /chats/:id — get conversation details
router.get('/chats/:id', requireOrg, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         cv.*,
         COALESCE(ct.name, ct.profile_name) AS contact_name,
         ct.tags,
         ct.assigned_user_id,
         u.display_name AS assigned_user_name
       FROM coexistence.conversations cv
       LEFT JOIN coexistence.contacts ct
         ON ct.wa_number = cv.wa_number
        AND ct.contact_number = cv.contact_number
        AND (ct.organization_id = cv.organization_id OR ct.organization_id IS NULL)
       LEFT JOIN coexistence.forgecrm_users u
         ON u.id = ct.assigned_user_id
       WHERE cv.id = $1 AND cv.organization_id = $2`,
      [req.params.id, req.org.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      ...rows[0],
      tags: rows[0].tags || [],
      unread_count: Number(rows[0].unread_count) || 0,
    });
  } catch (err) {
    console.error('[chats] get error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /chats/:id/messages — paginated messages for a conversation
router.get('/chats/:id/messages', requireOrg, async (req, res) => {
  try {
    const { rows: convRows } = await pool.query(
      `SELECT id, wa_number, contact_number
       FROM coexistence.conversations
       WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.org.id]
    );

    if (!convRows[0]) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { wa_number, contact_number } = convRows[0];
    const { page = '1', limit = '50', search = '', direction = 'all' } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const params = [wa_number, contact_number, req.org.id];
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

    // Attach reactions
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
        .reverse(), // oldest first for chronological chat display
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    });
  } catch (err) {
    console.error('[chats] messages error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /chats/:id/messages — send outbound message to a conversation
router.post('/chats/:id/messages', requireOrg, async (req, res) => {
  try {
    const { rows: convRows } = await pool.query(
      `SELECT id, whatsapp_account_id, wa_number, contact_number
       FROM coexistence.conversations
       WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.org.id]
    );

    if (!convRows[0]) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { wa_number, contact_number, whatsapp_account_id } = convRows[0];
    const { text, type = 'text', media, template, contextMessageId } = req.body || {};

    if (!text && !media && !template) {
      return res.status(400).json({ error: 'Message content (text, media, or template) is required' });
    }

    const result = await sendWhatsAppMessage({
      organizationId: req.org.id,
      accountId: whatsapp_account_id,
      fromNumber: wa_number,
      toNumber: contact_number,
      type,
      text,
      media,
      template,
      contextMessageId,
      db: pool,
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('[chats] send message error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// GET /chats/:id/ai-mode — return current AI state for a conversation
router.get('/chats/:id/ai-mode', requireOrg, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cv.id, cv.ai_enabled, cv.ai_last_action_at,
              cv.wa_number, cv.contact_number,
              c.agent_paused, c.agent_paused_at, c.agent_paused_by
         FROM coexistence.conversations cv
         LEFT JOIN coexistence.contacts c
           ON c.wa_number = cv.wa_number AND c.contact_number = cv.contact_number
              AND c.organization_id = cv.organization_id
        WHERE cv.id = $1 AND cv.organization_id = $2`,
      [req.params.id, req.org.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Conversation not found' });
    const r = rows[0];
    res.json({
      conversationId: r.id,
      aiEnabled: r.ai_enabled !== false, // treat null as enabled
      agentPaused: !!r.agent_paused,
      aiLastActionAt: r.ai_last_action_at,
      agentPausedAt: r.agent_paused_at,
      agentPausedBy: r.agent_paused_by,
    });
  } catch (err) {
    console.error('[chats:ai-mode] get error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

// POST /chats/:id/ai-mode — enable or disable AI for a conversation
// Body: { aiEnabled: boolean }
// When aiEnabled=false (human takeover): sets conversation.ai_enabled=false and
// contact.agent_paused=true so the agent queue skips future messages.
// When aiEnabled=true (return to AI): clears both flags.
router.post('/chats/:id/ai-mode', requireOrg, async (req, res) => {
  try {
    const orgId = req.org.id;
    const conversationId = req.params.id;
    const { aiEnabled } = req.body || {};

    if (typeof aiEnabled !== 'boolean') {
      return res.status(400).json({ error: 'aiEnabled (boolean) is required' });
    }

    // Verify conversation belongs to org
    const { rows: convRows } = await pool.query(
      `SELECT id, wa_number, contact_number FROM coexistence.conversations
        WHERE id = $1 AND organization_id = $2`,
      [conversationId, orgId]
    );
    if (!convRows[0]) return res.status(404).json({ error: 'Conversation not found' });
    const { wa_number, contact_number } = convRows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update conversation AI mode
      await client.query(
        `UPDATE coexistence.conversations
            SET ai_enabled = $1, ai_last_action_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND organization_id = $3`,
        [aiEnabled, conversationId, orgId]
      );

      // Update contact agent_paused flag (inverse of aiEnabled)
      await client.query(
        `UPDATE coexistence.contacts
            SET agent_paused = $1,
                agent_paused_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
                agent_paused_by = CASE WHEN $1 THEN $2 ELSE NULL END,
                updated_at = NOW()
          WHERE wa_number = $3 AND contact_number = $4 AND organization_id = $5`,
        [!aiEnabled, req.user?.id || null, wa_number, contact_number, orgId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Emit realtime update so inbox header reflects current AI mode
    try {
      emitConversationUpdated(orgId, {
        conversationId,
        waNumber: wa_number,
        contactNumber: contact_number,
        aiEnabled,
        agentPaused: !aiEnabled,
      });
    } catch { /* best-effort */ }

    console.log(`[chats:ai-mode] conversationId=${conversationId} aiEnabled=${aiEnabled} orgId=${orgId} by=${req.user?.id || 'unknown'}`);
    res.json({ ok: true, conversationId, aiEnabled, agentPaused: !aiEnabled });
  } catch (err) {
    console.error('[chats:ai-mode] set error:', err.message);
    const { status, body } = safeError(err);
    res.status(status).json(body);
  }
});

module.exports = { router };
