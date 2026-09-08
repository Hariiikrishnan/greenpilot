import { describe, it, expect } from 'vitest';
import { friendlyApiError, isAuthError } from './apiError.js';

describe('friendlyApiError', () => {
  it('maps 401 to a sign-in prompt without leaking internals', () => {
    expect(friendlyApiError({ status: 401, message: 'Invalid token' })).toMatch(/sign in/i);
  });

  it('maps 403 to a permission message', () => {
    expect(friendlyApiError({ status: 403, message: 'Forbidden' })).toMatch(/permission/i);
  });

  it('maps 404 honestly', () => {
    expect(friendlyApiError({ status: 404, message: 'Not found' })).toMatch(/not found/i);
  });

  it('maps 429 to rate-limit guidance', () => {
    expect(friendlyApiError({ status: 429, message: 'Too many' })).toMatch(/many requests/i);
  });

  it('collapses 500s to a generic message (no stack traces)', () => {
    const out = friendlyApiError({ status: 500, message: 'Error: boom at foo.js:12\n    at bar (baz.js:3)' });
    expect(out).not.toMatch(/at\s+\S+\s+\(/);
    expect(out).toMatch(/our side|try again/i);
  });

  it('maps machine codes: quota, subscription, onboarding, invites', () => {
    expect(friendlyApiError({ status: 403, code: 'quota-exceeded', message: 'x' })).toMatch(/usage limit|billing/i);
    expect(friendlyApiError({ status: 403, code: 'subscription-expired', message: 'x' })).toMatch(/expired|billing/i);
    expect(friendlyApiError({ status: 409, code: 'onboarding-incomplete', message: 'x' })).toMatch(/required setup/i);
    expect(friendlyApiError({ status: 409, code: 'already-member', message: 'x' })).toMatch(/already a member/i);
    expect(friendlyApiError({ status: 409, code: 'email-taken', message: 'x' })).toMatch(/already exists|signing in/i);
    expect(friendlyApiError({ status: 403, code: 'not-member', message: 'x' })).toMatch(/access/i);
  });

  it('passes WhatsApp-disconnected guidance through', () => {
    const out = friendlyApiError({ status: 400, message: 'WhatsApp is not connected. Connect a number.' });
    expect(out).toMatch(/whatsapp/i);
  });

  it('strips numeric status prefixes from raw bodies', () => {
    expect(friendlyApiError({ status: 409, message: '409 Organization slug already taken' }))
      .toBe('Organization slug already taken');
  });
});

describe('isAuthError', () => {
  it('is true only for 401', () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
