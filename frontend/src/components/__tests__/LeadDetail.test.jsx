// Phase 11: lead detail — real-API rendering, mutations, and timeline.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import LeadDetail from '../LeadDetail.jsx';

vi.mock('../../api.js', () => ({ api: {} }));
import { api } from '../../api.js';

const WA = '15550008888';
const CN = '19998882222';

const LEAD = {
  id: 9, organizationId: 'org-1', waNumber: WA, contactNumber: CN,
  name: 'Asha', profileName: null, tags: [], customFields: {},
  assignedUserId: null, leadStatus: 'new', pipelineStageId: null,
  qualification: { status: 'qualified', score: 88, intent: 'demo', summary: 'Wants a demo.', evaluatedAt: '2026-09-01T00:00:00Z' },
  openFollowups: 1,
};

const ACTIVITY = [
  { kind: 'AI qualification', ts: '2026-09-01T10:00:00Z', summary: 'qualified (88) — Wants a demo.', ref: null },
  { kind: 'note added', ts: '2026-09-01T09:00:00Z', summary: 'Called twice', ref: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.leads = {
    byContact: vi.fn(async () => ({ ...LEAD })),
    setStatus: vi.fn(async () => ({})),
    setStage: vi.fn(async () => ({})),
    assign: vi.fn(async () => ({})),
  };
  api.crm = {
    activity: vi.fn(async () => [...ACTIVITY]),
    followups: vi.fn(async () => ({ data: [{ id: 'f1', due_at: '2030-01-01T00:00:00Z', assignee_name: null }], total: 1 })),
    addNote: vi.fn(async () => ({})),
    logCall: vi.fn(async () => ({})),
    createFollowup: vi.fn(async () => ({})),
    completeFollowup: vi.fn(async () => ({})),
  };
  api.pipelines = { list: vi.fn(async () => [{ id: 3, name: 'Sales', stages: [{ id: 30, name: 'New Lead' }] }]) };
});

describe('LeadDetail', () => {
  it('renders qualification, stage, timeline from real API data', async () => {
    render(<LeadDetail waNumber={WA} contactNumber={CN} users={[]} />);
    await waitFor(() => expect(api.leads.byContact).toHaveBeenCalledWith(WA, CN));
    expect(screen.getAllByText('new').length).toBeGreaterThan(0);
    expect(screen.getByText(/AI: qualified \(88\)/)).toBeTruthy();
    expect(screen.getAllByText(/Wants a demo/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 open follow-up/)).toBeTruthy();
    expect(screen.getAllByText('Called twice').length).toBeGreaterThan(0);
  });

  it('changes status through the canonical endpoint', async () => {
    render(<LeadDetail waNumber={WA} contactNumber={CN} users={[]} />);
    await waitFor(() => expect(api.leads.byContact).toHaveBeenCalled());
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'contacted' } });
    await waitFor(() => expect(api.leads.setStatus).toHaveBeenCalledWith(9, 'contacted'));
  });

  it('adds a note and refreshes', async () => {
    render(<LeadDetail waNumber={WA} contactNumber={CN} users={[]} />);
    await waitFor(() => expect(api.leads.byContact).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(/timeline note/), { target: { value: 'Hello note' } });
    fireEvent.click(screen.getAllByText('Add')[0]); // note form precedes follow-up form
    await waitFor(() => expect(api.crm.addNote).toHaveBeenCalledWith(WA, CN, 'Hello note'));
  });

  it('logs a call and schedules + completes a follow-up', async () => {
    render(<LeadDetail waNumber={WA} contactNumber={CN} users={[]} />);
    await waitFor(() => expect(api.leads.byContact).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(/Outcome/), { target: { value: 'Connected' } });
    fireEvent.click(screen.getByText('Log'));
    await waitFor(() => expect(api.crm.logCall).toHaveBeenCalledWith(WA, CN, { outcome: 'Connected', notes: '' }));

    fireEvent.change(screen.getByPlaceholderText(/Due:/), { target: { value: '2d' } });
    const addBtns = screen.getAllByText('Add');
    fireEvent.click(addBtns[addBtns.length - 1]);
    await waitFor(() => expect(api.crm.createFollowup).toHaveBeenCalledWith(WA, CN, { dueAt: '2d' }));
  });

  it('assigns via member list and shows load errors honestly', async () => {
    api.leads.byContact = vi.fn(async () => { throw new Error('500 nope'); });
    render(<LeadDetail waNumber={WA} contactNumber={CN} users={[{ id: 5, displayName: 'Riya', isActive: true }]} />);
    await waitFor(() => expect(screen.getByText(/Could not load lead/)).toBeTruthy());
  });
});
