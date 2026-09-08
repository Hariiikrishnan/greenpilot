// Green Pilot qualification output validation (Phase 9).
//
// Raw model output is NEVER persisted. It must parse as JSON and satisfy this
// schema; anything else is rejected before any write, charge, or emit. Unknown
// keys are stripped, oversized strings truncated, impossible scores rejected.

const { z } = require('zod');

const QUALIFICATION_STATUSES = ['qualified', 'unqualified', 'needs-more-information', 'unknown'];

// over-long strings are ACCEPTED then truncated by clean() below (better
// than rejecting an otherwise-valid verdict); impossible enums/scores and
// missing summaries are rejected.
const qualificationResultSchema = z.object({
  status: z.union([
    z.literal('qualified'),
    z.literal('unqualified'),
    z.literal('needs-more-information'),
    z.literal('unknown'),
  ]),
  score: z.number().int().min(0).max(100).nullable().optional(),
  intent: z.string().nullable().optional(),
  budget: z.string().nullable().optional(),
  timeline: z.string().nullable().optional(),
  requirements: z.string().nullable().optional(),
  summary: z.string().min(1),
}); // default strip: unknown keys are dropped, never persisted

// Parse + sanitize one model response. Returns { ok:true, value } or
// { ok:false, reason }. Accepts a JSON string or an already-parsed object
// (adapters return finalText strings; tests may pass objects).
function parseQualificationResult(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().slice(0, 8000);
    // Tolerate code fences around the JSON payload, nothing more.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    try {
      obj = JSON.parse(fenced ? fenced[1] : text);
    } catch {
      return { ok: false, reason: 'malformed-json' };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'malformed-json' };
  }
  const parsed = qualificationResultSchema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, reason: 'schema-violation' };
  }
  const v = parsed.data;
  const clean = (s, max) => {
    if (s == null) return null;
    const t = String(s).trim().slice(0, max);
    return t === '' ? null : t;
  };
  return {
    ok: true,
    value: {
      status: v.status,
      score: v.score ?? null,
      intent: clean(v.intent, 120),
      budget: clean(v.budget, 500),
      timeline: clean(v.timeline, 500),
      requirements: clean(v.requirements, 1000),
      summary: String(v.summary).trim().slice(0, 1000),
    },
  };
}

module.exports = { QUALIFICATION_STATUSES, qualificationResultSchema, parseQualificationResult };
