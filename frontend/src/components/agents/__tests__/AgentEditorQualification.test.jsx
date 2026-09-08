// Phase 9: agent editor qualification controls — toggle + rules persist via
// the existing save path (server-owned fields, no new endpoints).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AgentEditor from '../AgentEditor.jsx';

vi.mock('../../../api.js', () => ({
  api: {
    aiModels: { list: vi.fn() },
    users: { list: vi.fn() },
    agents: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));
import { api } from '../../../api.js';

const AGENT = {
  id: 7, name: 'Quali', description: '', systemPrompt: 'Be nice.',
  aiModelId: null, llmModel: null, waAccountId: null, isActive: false,
  contextWindowMessages: 20, maxToolIterations: 6,
  transcribeAudio: false, acceptImages: false, crmToolsEnabled: false,
  handoffEnabled: false, handoffUserIds: [], handoffKeywords: '',
  closeSummaryEnabled: false, closeIdleMinutes: 30,
  triggerMode: 'any', triggerKeyword: '', triggerMatchType: 'contains',
  triggerCaseSensitive: false, triggerSessionMinutes: 30,
  mediaGroups: [], qualifyLeads: false, qualificationRules: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.aiModels.list.mockResolvedValue([]);
  api.users.list.mockResolvedValue([]);
  api.agents.get.mockResolvedValue({ ...AGENT });
  api.agents.update.mockResolvedValue({ ok: true });
});

describe('AgentEditor qualification', () => {
  it('shows saved qualify state and reveals the rules field when enabled', async () => {
    api.agents.get.mockResolvedValue({ ...AGENT, qualifyLeads: true, qualificationRules: 'Budget matters.' });
    render(<AgentEditor agentId={7} waAccounts={[]} user={{ role: 'admin' }} onDone={() => {}} onCancel={() => {}} />);
    const checkbox = await waitFor(() => screen.getByText('Qualify leads after agent replies'));
    expect(checkbox).toBeTruthy();
    expect(screen.getByDisplayValue('Budget matters.')).toBeTruthy();
  });

  it('persists qualifyLeads + qualificationRules through save', async () => {
    render(<AgentEditor agentId={7} waAccounts={[]} user={{ role: 'admin' }} onDone={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(api.agents.get).toHaveBeenCalled());

    const toggles = screen.getByText('Qualify leads after agent replies');
    const checkbox = toggles.closest('label').querySelector('input[type="checkbox"]');
    fireEvent.click(checkbox);
    const rules = screen.getByPlaceholderText(/delivery city/);
    fireEvent.change(rules, { target: { value: 'Needs a city.' } });

    const saveBtn = screen.getByText('Save changes');
    fireEvent.click(saveBtn);
    await waitFor(() => expect(api.agents.update).toHaveBeenCalled());
    const payload = api.agents.update.mock.calls[0][1];
    expect(payload.qualifyLeads).toBe(true);
    expect(payload.qualificationRules).toBe('Needs a city.');
  });
});
