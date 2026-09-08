// Green Pilot lead detail (Phase 11) — qualification, stage/status,
// assignment, timeline, notes, calls, and follow-ups for one lead.
//
// Lead ≡ org-owned contact; everything here round-trips through the
// canonical /v1/leads + /v1/crm APIs (no local-only state). Realtime
// refresh hints (lead-updated / activity-created / ...) are accepted via the
// optional `refreshKey` prop — the parent re-renders it on socket events.

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertTriangle, Check, Phone, Clock, StickyNote, Flag } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, maskPhone } from '../constants.js';
import SearchableSelect from './SearchableSelect.jsx';

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'needs-more-information', 'won', 'lost'];

const STATUS_COLORS = {
  new: '#6B7280',
  contacted: '#2563EB',
  qualified: '#047857',
  unqualified: '#B91C1C',
  'needs-more-information': '#B45309',
  won: '#047857',
  lost: '#6B7280',
  unknown: '#6B7280',
};

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, margin: '16px 0 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ width: 110, flexShrink: 0, fontSize: 12, color: C.textMuted }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '7px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
  fontSize: 13, fontFamily: FONT, color: C.text, outline: 'none',
  background: 'var(--c-cardBg)', boxSizing: 'border-box',
};

export default function LeadDetail({ waNumber, contactNumber, refreshKey, users = [] }) {
  const [lead, setLead] = useState(null);
  const [activity, setActivity] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [callOutcome, setCallOutcome] = useState('');
  const [callNotes, setCallNotes] = useState('');
  const [followupDue, setFollowupDue] = useState('');
  const [followups, setFollowups] = useState([]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [l, a, f] = await Promise.all([
        api.leads.byContact(waNumber, contactNumber),
        api.crm.activity(waNumber, contactNumber, 30).catch(() => []),
        api.crm.followups(waNumber, contactNumber, { status: 'pending' }).catch(() => ({ data: [] })),
      ]);
      setLead(l);
      setActivity(Array.isArray(a) ? a : []);
      setFollowups(Array.isArray(f?.data) ? f.data : (Array.isArray(f) ? f : []));
    } catch (err) {
      setError(`Could not load lead: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [waNumber, contactNumber]);

  useEffect(() => { setLoading(true); refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    api.pipelines.list().then(setPipelines).catch(() => setPipelines([]));
  }, []);

  const mutate = async (key, fn, okMsg) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.textMuted, fontSize: 13, padding: '12px 0' }}>
        <Loader2 size={14} /> Loading lead…
      </div>
    );
  }
  if (error && !lead) {
    return <div style={{ color: '#B91C1C', fontSize: 13, padding: '12px 0' }}>{error}</div>;
  }
  if (!lead) return null;

  const statusColor = STATUS_COLORS[lead.leadStatus] || STATUS_COLORS.unknown;
  const allStages = (pipelines || []).flatMap(p => (p.stages || []).map(s => ({ ...s, pipelineName: p.name })));
  const activeUsers = (users || []).filter(u => u.isActive !== false);

  return (
    <div style={{ fontFamily: FONT }}>
      {error && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: '#FEF2F2', color: '#B91C1C', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginBottom: 8 }}>
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {notice && (
        <div style={{ background: '#ECFDF5', color: '#047857', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginBottom: 8 }}>
          {notice}
        </div>
      )}

      {/* Status + qualification */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 999, background: `${statusColor}18`, color: statusColor }}>
          {lead.leadStatus}
        </span>
        {lead.qualification && (
          <span style={{ fontSize: 12, color: C.textSecondary }}>
            AI: {lead.qualification.status}{lead.qualification.score != null ? ` (${lead.qualification.score})` : ''}
          </span>
        )}
        {lead.openFollowups > 0 && (
          <span style={{ fontSize: 12, color: '#B45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Clock size={12} /> {lead.openFollowups} open follow-up{lead.openFollowups === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {lead.qualification?.summary && (
        <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.5, marginBottom: 4 }}>{lead.qualification.summary}</div>
      )}

      <SectionTitle>Pipeline & Assignment</SectionTitle>
      <Row label="Status">
        <select
          value={lead.leadStatus}
          disabled={!!busy}
          onChange={(e) => mutate('status', () => api.leads.setStatus(lead.id, e.target.value), 'Status updated.')}
          style={inputStyle}
        >
          {LEAD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Row>
      <Row label="Stage">
        <select
          value={lead.pipelineStageId || ''}
          disabled={!!busy}
          onChange={(e) => mutate('stage', () => api.leads.setStage(lead.id, e.target.value === '' ? null : Number(e.target.value)), 'Stage updated.')}
          style={inputStyle}
        >
          <option value="">— No stage —</option>
          {allStages.map(s => <option key={s.id} value={s.id}>{s.pipelineName} → {s.name}</option>)}
        </select>
      </Row>
      <Row label="Assigned to">
        <SearchableSelect
          value={lead.assignedUserId ? String(lead.assignedUserId) : ''}
          onChange={(val) => mutate('assign', () => api.leads.assign(lead.id, val === '' ? null : Number(val)), 'Assignment updated.')}
          options={[{ value: '', label: 'Unassigned' }, ...activeUsers.map(u => ({ value: String(u.id), label: u.displayName || u.username }))]}
          placeholder="Unassigned"
          searchPlaceholder="Search team..."
          triggerStyle={{ padding: '7px 10px', border: `1px solid ${C.border}` }}
        />
      </Row>

      <SectionTitle>Add Note</SectionTitle>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
          placeholder="Write a timeline note…"
          style={inputStyle}
        />
        <button
          disabled={!!busy || !noteText.trim()}
          onClick={() => mutate('note', async () => {
            await api.crm.addNote(waNumber, contactNumber, noteText.trim());
            setNoteText('');
          }, 'Note added.')}
          style={{ border: 'none', background: C.primary, color: '#fff', borderRadius: 8, padding: '0 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT }}
        >
          Add
        </button>
      </div>

      <SectionTitle>Log Call</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={callOutcome} onChange={e => setCallOutcome(e.target.value)} placeholder="Outcome (e.g. Connected, No answer)" style={inputStyle} />
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={callNotes} onChange={e => setCallNotes(e.target.value)} placeholder="Summary (optional)" style={inputStyle} />
          <button
            disabled={!!busy}
            onClick={() => mutate('call', async () => {
              await api.crm.logCall(waNumber, contactNumber, { outcome: callOutcome, notes: callNotes });
              setCallOutcome('');
              setCallNotes('');
            }, 'Call logged.')}
            style={{ border: `1px solid ${C.border}`, background: 'transparent', borderRadius: 8, padding: '0 12px', fontSize: 13, cursor: 'pointer', color: C.text, fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Phone size={13} /> Log
          </button>
        </div>
      </div>

      <SectionTitle>Follow-ups</SectionTitle>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          value={followupDue}
          onChange={e => setFollowupDue(e.target.value)}
          placeholder="Due: 2026-09-10 15:00 or 2d / 4h"
          style={{ ...inputStyle, fontFamily: 'inherit' }}
        />
        <button
          disabled={!!busy || !followupDue.trim()}
          onClick={() => mutate('followup', async () => {
            await api.crm.createFollowup(waNumber, contactNumber, { dueAt: followupDue.trim() });
            setFollowupDue('');
          }, 'Follow-up scheduled.')}
          style={{ border: 'none', background: C.primary, color: '#fff', borderRadius: 8, padding: '0 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT }}
        >
          Add
        </button>
      </div>
      {followups.map(f => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textSecondary, padding: '6px 0', borderTop: `1px solid ${C.border}` }}>
          <Flag size={12} />
          <span style={{ flex: 1 }}>Due {f.due_at ? new Date(f.due_at).toLocaleString() : '—'}{f.assignee_name ? ` · ${f.assignee_name}` : ''}</span>
          <button
            disabled={!!busy}
            onClick={() => mutate(`done-${f.id}`, () => api.crm.completeFollowup(f.id), 'Follow-up completed.')}
            title="Mark completed"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#047857' }}
          >
            <Check size={14} />
          </button>
        </div>
      ))}

      <SectionTitle>Timeline</SectionTitle>
      {activity.length === 0 && <div style={{ fontSize: 12, color: C.textMuted }}>No activity yet.</div>}
      {activity.map((a, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, padding: '7px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`, fontSize: 12 }}>
          <span style={{ flexShrink: 0, fontWeight: 700, color: C.primary, minWidth: 110 }}>{a.kind}</span>
          <span style={{ flex: 1, color: C.textSecondary, lineHeight: 1.45 }}>{a.summary || '—'}</span>
          <span style={{ flexShrink: 0, color: C.textMuted, fontSize: 11 }}>
            {a.ts ? new Date(a.ts).toLocaleString() : ''}
          </span>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 11, color: C.textMuted }}>
        <StickyNote size={11} />
        <span>WhatsApp: +{maskPhone(contactNumber)} · updates appear here live via team inbox events</span>
      </div>
    </div>
  );
}
