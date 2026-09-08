// One-time audit (Phase 10): report stored automation configs that would NOT
// validate under the canonical validator (e.g. parked/unsafe node types from
// pre-Phase-10 saves). Read-only — nothing is rewritten (the destructive
// linearizer this script once used was removed in Phase 10).
//
//   cd backend && node scripts/migrateLinearAutomations.js

require('dotenv').config();
const pool = require('../src/db');
const { validateAutomationConfig } = require('../src/automation/service');

(async () => {
  try {
    const { rows } = await pool.query('SELECT id, name, config FROM coexistence.chatbots');
    let invalid = 0;
    for (const r of rows) {
      try {
        validateAutomationConfig(r.config || {});
      } catch (err) {
        invalid++;
        console.log(`  #${r.id} "${r.name}": ${err.message}`);
      }
    }
    console.log(`Done. ${invalid}/${rows.length} automation(s) need attention.`);
  } catch (err) {
    console.error('Audit failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
