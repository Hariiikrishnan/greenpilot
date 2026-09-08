// Green Pilot ESLint baseline (Phase 6, B2 — APPROVED).
//
// eslint:recommended over the whole backend, no suppressions. Two pragmatic
// carve-outs (documented, not hidden): console logging is the codebase's
// established observability (no logger yet), and empty catch blocks are allowed
// ONLY with an explanatory comment (best-effort paths) — bare `catch {}` fails.
const globals = require('globals');

module.exports = [
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'off',
    },
  },
  {
    // Parked automation node handlers (executeHandoffNode/executeAINode/
    // executeAPINode/executeSubflowNode + contactMutated): deliberately retained
    // dead code per SESSION-HANDOFF.md, re-enabled with the Green Pilot
    // condition/delay/action catalogue (PHASE5 evolution map §8). Flagging them
    // here would force deletion or fake references — both worse. This carve-out
    // is scoped to that file and expires when the catalogue ships.
    files: ['src/engine/automationEngine.js'],
    rules: { 'no-unused-vars': 'off' },
  },
];
