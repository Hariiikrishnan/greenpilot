// Phase 8 frontend billing tests: real-data rendering, server plan identity,
// success/failure handling, stale-state convergence, and role gating.
// No fake timers, no fake payment success — the Razorpay SDK boundary is
// injected via window.Razorpay.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../api.js', () => ({ api: { billing: {} } }));
import { api } from '../../../api.js';
import BillingTab from '../BillingTab.jsx';

const STATUS_MANAGER = {
  organizationId: 'org-1',
  plan: 'trial',
  planName: 'Trial',
  state: 'trialing',
  entitled: true,
  trialEndsAt: '2026-09-01T00:00:00.000Z',
  currentPeriodEnd: null,
  usage: { granted: 100, used: 30, remaining: 70 },
  canManageBilling: true,
  providerConfigured: true,
  pricingFinalized: false,
};

const PLANS = {
  plans: [
    { id: 'trial', name: 'Trial', pricePaise: 0, currency: 'INR', interval: null, aiCreditsPerCycle: 100, features: ['Team inbox'], orderable: false, pricingFinalized: false },
    { id: 'starter', name: 'Starter', pricePaise: 0, currency: 'INR', interval: 'month', aiCreditsPerCycle: 1000, features: ['Everything'], orderable: true, pricingFinalized: false },
  ],
  pricingFinalized: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete window.Razorpay;
  api.billing.status = vi.fn(async () => ({ ...STATUS_MANAGER }));
  api.billing.plans = vi.fn(async () => JSON.parse(JSON.stringify(PLANS)));
  api.billing.createOrder = vi.fn();
  api.billing.verifyPayment = vi.fn();
  api.billing.cancel = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('BillingTab', () => {
  it('loads and renders real backend data (plan, state, usage)', async () => {
    render(<BillingTab />);
    await waitFor(() => expect(screen.getByText('Billing')).toBeTruthy());
    await waitFor(() => expect(api.billing.status).toHaveBeenCalled());
    expect(screen.getAllByText('Trial').length).toBeGreaterThan(0); // status card + plan card
    expect(screen.getByText('trialing')).toBeTruthy();
    expect(screen.getByText(/30 used of 100/)).toBeTruthy();
    expect(screen.getByText(/prices are not yet finalized/)).toBeTruthy();
  });

  it('marks the server-reported current plan (server identity, not local guess)', async () => {
    render(<BillingTab />);
    await waitFor(() => expect(screen.getByText('Current plan')).toBeTruthy());
    // Only the trial card carries the marker.
    expect(screen.getAllByText('Current plan')).toHaveLength(1);
  });

  it('hides management actions from non-managers (read-only)', async () => {
    api.billing.status = vi.fn(async () => ({ ...STATUS_MANAGER, canManageBilling: false }));
    render(<BillingTab />);
    await waitFor(() => expect(api.billing.status).toHaveBeenCalled());
    expect(screen.queryByText(/Upgrade to/)).toBeNull();
    expect(screen.getByText(/Only organization owners and admins/)).toBeTruthy();
  });

  it('shows unconfigured state instead of a fake checkout', async () => {
    api.billing.status = vi.fn(async () => ({ ...STATUS_MANAGER, providerConfigured: false }));
    render(<BillingTab />);
    await waitFor(() => expect(api.billing.status).toHaveBeenCalled());
    expect(screen.queryByText(/Upgrade to/)).toBeNull();
    expect(screen.getByText(/not configured for this workspace/)).toBeTruthy();
  });

  it('upgrade uses the server plan id and verifies the payment (success)', async () => {
    const order = { providerOrderId: 'order_9', receipt: 'gp_x', amountPaise: 0, currency: 'INR', plan: 'starter', publicKey: 'rzp_test_x' };
    api.billing.createOrder = vi.fn(async () => order);
    let capturedOptions = null;
    window.Razorpay = vi.fn(function (opts) {
      capturedOptions = opts;
      return { open: vi.fn(), on: vi.fn() };
    });
    api.billing.verifyPayment = vi.fn(async () => ({ ok: true, alreadyProcessed: false }));

    render(<BillingTab />);
    const btn = await waitFor(() => screen.getByText('Upgrade to Starter'));
    fireEvent.click(btn);
    await waitFor(() => expect(api.billing.createOrder).toHaveBeenCalledWith('starter'));
    expect(capturedOptions.order_id).toBe('order_9');
    expect(capturedOptions.key).toBe('rzp_test_x');
    // Simulate the checkout handler callback (real SDK would invoke this).
    await capturedOptions.handler({ razorpay_payment_id: 'pay_1', razorpay_signature: 'sig_1' });
    expect(api.billing.verifyPayment).toHaveBeenCalledWith({
      providerOrderId: 'order_9', providerPaymentId: 'pay_1', signature: 'sig_1',
    });
    await waitFor(() => expect(screen.getByText(/Payment verified/)).toBeTruthy());
  });

  it('surfaces verification failure without claiming success', async () => {
    const order = { providerOrderId: 'order_9', amountPaise: 0, currency: 'INR', plan: 'starter', publicKey: 'rzp_test_x' };
    api.billing.createOrder = vi.fn(async () => order);
    let capturedOptions = null;
    window.Razorpay = vi.fn(function (opts) {
      capturedOptions = opts;
      return { open: vi.fn(), on: vi.fn() };
    });
    api.billing.verifyPayment = vi.fn(async () => { throw new Error('403 {"error":"Payment signature verification failed"}'); });

    render(<BillingTab />);
    const btn = await waitFor(() => screen.getByText('Upgrade to Starter'));
    fireEvent.click(btn);
    await waitFor(() => expect(api.billing.createOrder).toHaveBeenCalled());
    await capturedOptions.handler({ razorpay_payment_id: 'pay_1', razorpay_signature: 'bad' });
    await waitFor(() => expect(screen.getByText(/could not be verified/)).toBeTruthy());
    expect(screen.queryByText(/Payment verified/)).toBeNull();
  });

  it('dismissed payment re-reads server state (no stale success)', async () => {
    const order = { providerOrderId: 'order_9', amountPaise: 0, currency: 'INR', plan: 'starter', publicKey: 'rzp_test_x' };
    api.billing.createOrder = vi.fn(async () => order);
    let capturedOptions = null;
    window.Razorpay = vi.fn(function (opts) {
      capturedOptions = opts;
      return { open: vi.fn(), on: vi.fn() };
    });
    render(<BillingTab />);
    const btn = await waitFor(() => screen.getByText('Upgrade to Starter'));
    fireEvent.click(btn);
    await waitFor(() => expect(api.billing.createOrder).toHaveBeenCalled());
    const callsBefore = api.billing.status.mock.calls.length;
    await capturedOptions.modal.ondismiss();
    await waitFor(() => expect(api.billing.status.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.getByText(/no charge was confirmed/)).toBeTruthy();
  });

  it('cancel asks for confirmation and refreshes state', async () => {
    api.billing.status = vi.fn(async () => ({ ...STATUS_MANAGER, plan: 'starter', planName: 'Starter', state: 'active' }));
    api.billing.cancel = vi.fn(async () => ({ ok: true }));
    render(<BillingTab />);
    const btn = await waitFor(() => screen.getByText('Cancel subscription'));
    fireEvent.click(btn);
    await waitFor(() => expect(api.billing.cancel).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/cancelled/)).toBeTruthy());
  });

  it('shows backend errors instead of fake data', async () => {
    api.billing.status = vi.fn(async () => { throw new Error('500 nope'); });
    render(<BillingTab />);
    await waitFor(() => expect(screen.getByText(/Could not load billing/)).toBeTruthy());
  });
});
