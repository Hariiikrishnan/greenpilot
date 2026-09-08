// Phase 9: inbox qualification banner — loads real API data, refreshes on
// tenant-scoped lead-qualified events, ignores foreign conversations.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import ChatWindow from '../ChatWindow.jsx';

vi.mock('../../api.js', () => ({
  api: {
    saveContact: vi.fn(),
    contact: vi.fn(),
    contactNames: vi.fn(),
    markRead: vi.fn(),
    messages: vi.fn(),
    windowStatus: vi.fn(),
    contacts: vi.fn(),
    numbers: vi.fn(),
    resolveAccountByPhone: vi.fn(),
    react: vi.fn(),
    star: vi.fn(),
    categories: { list: vi.fn() },
    tags: { list: vi.fn() },
    users: { list: vi.fn() },
    contactFields: { list: vi.fn() },
    mediaLibrary: { list: vi.fn(), downloadUrl: vi.fn() },
    sendMessage: vi.fn(), sendMedia: vi.fn(), sendAudio: vi.fn(), sendLibraryMedia: vi.fn(),
    ai: { qualifications: vi.fn() },
    agentConversation: { status: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  },
}));
import { api } from '../../api.js';

let realtimeCallback = null;
vi.mock('../../hooks/useRealtime.js', () => ({
  useRealtime: vi.fn((cb) => { realtimeCallback = cb; }),
}));

const WA = '15550001111';
const CN = '19998887777';

const QUAL = {
  id: 'q-1', status: 'qualified', score: 82, intent: 'pricing question',
  summary: 'Customer asked for bulk pricing.',
};

beforeEach(() => {
  vi.clearAllMocks();
  realtimeCallback = null;
  api.contactNames.mockResolvedValue({});
  api.contact.mockResolvedValue({ contact_number: CN, tags: [], custom_fields: {} });
  api.messages.mockResolvedValue({ messages: [], totalPages: 1 });
  api.markRead.mockResolvedValue({ ok: true });
  api.windowStatus.mockResolvedValue({ canSendFreeForm: true });
  api.categories.list.mockResolvedValue([]);
  api.tags.list.mockResolvedValue([]);
  api.users.list.mockResolvedValue([]);
  api.contactFields.list.mockResolvedValue([]);
  api.saveContact.mockResolvedValue({ ok: true });
  api.numbers.mockResolvedValue([]);
  api.resolveAccountByPhone.mockResolvedValue(null);
  api.contacts.mockResolvedValue([]);
  api.mediaLibrary.list.mockResolvedValue([]);
  api.agentConversation.status.mockResolvedValue({ hasAgent: true, paused: false });
  api.ai.qualifications.mockResolvedValue([QUAL]);
});

describe('ChatWindow qualification banner', () => {
  it('loads and renders the latest qualification from the API', async () => {
    render(<ChatWindow waNumber={WA} contactNumber={CN} onContactSaved={() => {}} />);
    await waitFor(() => expect(api.ai.qualifications).toHaveBeenCalledWith(WA, CN, 1));
    await waitFor(() => expect(screen.getByText(/AI qualification: qualified/)).toBeTruthy());
    expect(screen.getByText(/score 82\/100/)).toBeTruthy();
    expect(screen.getByText(/bulk pricing/)).toBeTruthy();
  });

  it('refreshes on a matching lead-qualified event, ignores foreign ones', async () => {
    render(<ChatWindow waNumber={WA} contactNumber={CN} onContactSaved={() => {}} />);
    await waitFor(() => expect(api.ai.qualifications).toHaveBeenCalledTimes(1));
    expect(realtimeCallback).toBeTruthy();

    await act(async () => {
      realtimeCallback({ type: 'lead-qualified', data: { organizationId: 'org-a', waNumber: '999', contactNumber: '888' } });
    });
    expect(api.ai.qualifications).toHaveBeenCalledTimes(1); // foreign ignored

    const updated = { ...QUAL, summary: 'Updated verdict.' };
    api.ai.qualifications.mockResolvedValue([updated]);
    await act(async () => {
      realtimeCallback({ type: 'lead-qualified', data: { organizationId: 'org-a', waNumber: WA, contactNumber: CN } });
    });
    await waitFor(() => expect(api.ai.qualifications).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Updated verdict/)).toBeTruthy());
  });

  it('renders nothing when no qualification exists', async () => {
    api.ai.qualifications.mockResolvedValue([]);
    render(<ChatWindow waNumber={WA} contactNumber={CN} onContactSaved={() => {}} />);
    await waitFor(() => expect(api.ai.qualifications).toHaveBeenCalled());
    expect(screen.queryByText(/AI qualification:/)).toBeNull();
  });
});
