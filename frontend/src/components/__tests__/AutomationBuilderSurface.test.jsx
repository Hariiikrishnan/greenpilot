// Phase 10: approved builder surface — trigger display, node defaults, and
// the canonical automations API shape.

import { describe, it, expect } from 'vitest';
import { getTriggerDisplay, makeNode, LEAD_STATUSES } from '../AutomationBuilderView.jsx';

describe('automation builder approved surface', () => {
  it('displays all approved trigger kinds', () => {
    const cases = {
      keyword: 'keyword',
      message_received: 'Message received',
      lead_created: 'New lead',
      lead_qualified: 'Lead qualified',
      lead_status_changed: 'Lead status changed',
      followup_due: 'Follow-up due',
    };
    for (const [kind, text] of Object.entries(cases)) {
      const d = getTriggerDisplay({ triggerKind: kind, keyword: 'HI' });
      expect(d.title.toLowerCase()).toContain(text.toLowerCase());
    }
  });

  it('exposes the four canonical qualification statuses for actions', () => {
    expect([...LEAD_STATUSES].sort()).toEqual(
      ['needs-more-information', 'qualified', 'unknown', 'unqualified'].sort()
    );
  });

  it('makeNode builds trigger/action nodes with server-approved defaults', () => {
    const t = makeNode('trigger', 0, 0, 't1');
    expect(t.triggerKind).toBe('keyword');
    const a = makeNode('action', 0, 0, 'a1');
    expect(a.actions).toEqual([]);
  });
});

describe('api.automations', () => {
  it('exposes the canonical surface including testRun', async () => {
    const mod = await import('../../api.js');
    for (const fn of ['list', 'get', 'create', 'update', 'enable', 'disable', 'duplicate', 'remove', 'executions', 'testRun']) {
      expect(typeof mod.api.automations[fn]).toBe('function');
    }
  });
});
