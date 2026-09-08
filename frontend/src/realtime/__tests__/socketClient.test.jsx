// Phase 7 frontend realtime tests: socket store lifecycle, org filtering,
// idempotent dispatch, safe reconnect behavior, and hook cleanup.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useCallback } from 'react';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
import { io } from 'socket.io-client';

vi.mock('../../api.js', () => ({
  getActiveOrgId: vi.fn(() => null),
}));
import { getActiveOrgId } from '../../api.js';

import {
  connectRealtime,
  disconnectRealtime,
  subscribeRealtime,
  onRealtimeStatusChange,
  getRealtimeStatus,
  __resetRealtimeForTests,
  __setActiveOrgForTests,
  __dispatchRealtimeForTests,
} from '../socketClient.js';
import { useRealtime } from '../../hooks/useRealtime.js';

const ORG_A = 'org-a-id';
const ORG_B = 'org-b-id';

function makeFakeSocket() {
  const handlers = new Map();
  return {
    handlers,
    connected: false,
    connect: vi.fn(function () { this.connected = true; }),
    disconnect: vi.fn(function () { this.connected = false; }),
    removeAllListeners: vi.fn(),
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    fire(event, ...args) {
      for (const fn of handlers.get(event) || []) fn(...args);
    },
  };
}

let fake;
beforeEach(() => {
  __resetRealtimeForTests();
  vi.clearAllMocks();
  fake = makeFakeSocket();
  io.mockReturnValue(fake);
  getActiveOrgId.mockReturnValue(null);
});

describe('socketClient connection lifecycle', () => {
  it('creates exactly one socket no matter how often connect is called', () => {
    connectRealtime();
    connectRealtime();
    connectRealtime();
    expect(io).toHaveBeenCalledTimes(1);
  });

  it('reports connected status on socket connect', () => {
    const seen = [];
    onRealtimeStatusChange((s) => seen.push(s));
    connectRealtime();
    fake.fire('connect');
    expect(getRealtimeStatus()).toBe('connected');
    expect(seen).toContain('connected');
  });

  it('disconnect tears down and reports disconnected', () => {
    connectRealtime();
    fake.fire('connect');
    disconnectRealtime();
    expect(fake.disconnect).toHaveBeenCalled();
    expect(getRealtimeStatus()).toBe('disconnected');
  });

  it('auth failure stops the retry loop and reports unauthorized (no hot-loop)', () => {
    connectRealtime();
    fake.fire('connect_error', new Error('Authentication failed'));
    expect(fake.disconnect).toHaveBeenCalled();
    expect(getRealtimeStatus()).toBe('unauthorized');
  });

  it('transient errors report error but keep reconnecting', () => {
    connectRealtime();
    fake.fire('connect_error', new Error('xhr poll error'));
    expect(getRealtimeStatus()).toBe('error');
    expect(fake.disconnect).not.toHaveBeenCalled();
  });
});

describe('socketClient event dispatch + tenant filter', () => {
  it('delivers subscribed events to handlers', () => {
    connectRealtime();
    const got = [];
    const unsub = subscribeRealtime('inbound-message', (d) => got.push(d));
    __dispatchRealtimeForTests('inbound-message', { messageId: 'm1', organizationId: ORG_A });
    expect(got).toHaveLength(1);
    unsub();
    __dispatchRealtimeForTests('inbound-message', { messageId: 'm2', organizationId: ORG_A });
    expect(got).toHaveLength(1); // cleanup stops delivery
  });

  it('drops foreign-org events when an org is active (defense in depth)', () => {
    __setActiveOrgForTests(ORG_A);
    connectRealtime();
    const got = [];
    subscribeRealtime('inbound-message', (d) => got.push(d));
    __dispatchRealtimeForTests('inbound-message', { messageId: 'foreign', organizationId: ORG_B });
    expect(got).toHaveLength(0);
    __dispatchRealtimeForTests('inbound-message', { messageId: 'own', organizationId: ORG_A });
    expect(got).toHaveLength(1);
  });

  it('drops canonical events missing organizationId while an org is active', () => {
    __setActiveOrgForTests(ORG_A);
    connectRealtime();
    const got = [];
    subscribeRealtime('conversation-updated', (d) => got.push(d));
    __dispatchRealtimeForTests('conversation-updated', { waNumber: '1' });
    expect(got).toHaveLength(0);
  });

  it('dedupes replays by eventId (idempotent reconnect)', () => {
    connectRealtime();
    const got = [];
    subscribeRealtime('message-status-update', (d) => got.push(d));
    const payload = { messageId: 'm9', status: 'read', organizationId: ORG_A, eventId: 'evt-1' };
    __dispatchRealtimeForTests('message-status-update', payload);
    __dispatchRealtimeForTests('message-status-update', payload);
    __dispatchRealtimeForTests('message-status-update', payload);
    expect(got).toHaveLength(1);
  });

  it('isolates listener faults (one throwing handler does not break others)', () => {
    connectRealtime();
    const got = [];
    subscribeRealtime('lead-qualified', () => { throw new Error('boom'); });
    subscribeRealtime('lead-qualified', (d) => got.push(d));
    __dispatchRealtimeForTests('lead-qualified', { contactNumber: '1', organizationId: ORG_A });
    expect(got).toHaveLength(1);
  });
});

describe('useRealtime hook', () => {
  it('connects once, forwards all canonical events, and cleans up on unmount', () => {
    const received = [];
    function Probe() {
      const onEvent = useCallback((ev) => received.push(ev), []);
      useRealtime(onEvent);
      return null;
    }
    const { unmount } = render(<Probe />);
    expect(io).toHaveBeenCalledTimes(1);

    act(() => {
      for (const type of ['inbound-message', 'message-status-update', 'conversation-updated', 'lead-qualified']) {
        // Route through the socket's own listeners (the real wiring path).
        for (const fn of fake.handlers.get(type) || []) fn({ organizationId: ORG_A, _t: type });
      }
    });
    expect(received.map((r) => r.type).sort()).toEqual(
      ['conversation-updated', 'inbound-message', 'lead-qualified', 'message-status-update'].sort()
    );

    unmount();
    act(() => {
      __dispatchRealtimeForTests('inbound-message', { organizationId: ORG_A });
    });
    expect(received).toHaveLength(4); // no deliveries after unmount
  });

  it('does nothing when onEvent is absent', () => {
    function Probe() {
      useRealtime(null);
      return null;
    }
    render(<Probe />);
    expect(io).not.toHaveBeenCalled();
  });
});
