// Phase 13 request-id middleware unit tests (pure — no DB, no app boot).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requestId } = require('../src/middleware/requestId');

function mockReq(incoming) {
  return {
    get: (name) => (name === 'x-request-id' ? incoming : null),
  };
}

function mockRes() {
  return {
    headers: {},
    set(name, value) { this.headers[name] = value; },
  };
}

test('generates and echoes a request id when none is supplied', () => {
  const req = mockReq(null);
  const res = mockRes();
  let nexted = false;
  requestId(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.match(req.id, /^[0-9a-f]{16}$/);
  assert.equal(res.headers['X-Request-Id'], req.id);
});

test('honors a well-formed incoming X-Request-Id', () => {
  const req = mockReq('client-trace-123');
  const res = mockRes();
  requestId(req, res, () => {});
  assert.equal(req.id, 'client-trace-123');
  assert.equal(res.headers['X-Request-Id'], 'client-trace-123');
});

test('rejects malformed incoming ids (injection-safe)', () => {
  const req = mockReq('evil\r\nHeader: x');
  const res = mockRes();
  requestId(req, res, () => {});
  assert.notEqual(req.id, 'evil\r\nHeader: x');
  assert.match(req.id, /^[0-9a-f]{16}$/);
});
