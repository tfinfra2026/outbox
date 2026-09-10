// Wipes every table EXCEPT `users`, so your login still works after running this.
// This is a full "factory reset" of campaign/mailbox/domain/template data - it clears
// mailboxes, domains, templates, campaigns, prospects, lists, sends/tracking history,
// suppression list, settings, and the audit log. You'll need to re-add SMTP mailboxes,
// re-verify domains, and rebuild templates before creating your next campaign.
//
// Safety: running this with no arguments only shows you current row counts and does
// NOT delete anything. You have to re-run it with --yes to actually wipe the data.
//
// Usage (from the backend folder):
//   node reset-data.js         -> dry run, shows what would be deleted
//   node reset-data.js --yes   -> actually deletes it

require('dotenv').config();
const db = require('./db/index');

// Children first, so foreign keys never block a delete (also matters for the
// SQLite path, which doesn't get FOREIGN_KEY_CHECKS=0 the way MySQL does below).
const TABLES_TO_WIPE = [
  'sends',
  'campaign_prospects',
  'sequence_steps',
  'campaign_mailboxes',
  'campaigns',
  'list_prospects',
  'lists',
  'suppression_list',
  'prospects',
  'audit_log',
  'mailboxes',
  'domains',
  'templates',
  'settings'
];

async function countRows() {
  const counts = {};
  for (const table of TABLES_TO_WIPE) {
    try {
      const rows = await db.query(`SELECT COUNT(*) as c FROM ${table}`);
      counts[table] = rows[0].c;
    } catch (e) {
      counts[table] = `error: ${e.message}`;
    }
  }
  return counts;
}

async function main() {
  await db.init();
  const confirmed = process.argv.includes('--yes');

  console.log(`\n[reset-data] Connected via driver: ${db.driverName}\n`);
  const before = await countRows();
  console.log('Current row counts:');
  for (const [table, count] of Object.entries(before)) console.log(`  ${table.padEnd(20)} ${count}`);

  if (!confirmed) {
    console.log('\nDry run only - nothing was deleted.');
    console.log('The `users` table (your login) is never touched by this script.');
    console.log('Re-run with --yes to actually wipe the tables above:\n  node reset-data.js --yes\n');
    return;
  }

  console.log('\n--yes passed - wiping data now...\n');

  if (db.driverName === 'mysql') {
    await db.run('SET FOREIGN_KEY_CHECKS=0');
    for (const table of TABLES_TO_WIPE) {
      await db.run(`TRUNCATE TABLE ${table}`);
      console.log(`  cleared ${table}`);
    }
    await db.run('SET FOREIGN_KEY_CHECKS=1');
  } else {
    for (const table of TABLES_TO_WIPE) {
      await db.run(`DELETE FROM ${table}`);
      // Reset SQLite's autoincrement counter too, so the next campaign/prospect/etc.
      // starts back at id=1 instead of continuing from wherever it left off.
      try { await db.run('DELETE FROM sqlite_sequence WHERE name = ?', [table]); } catch (e) {}
      console.log(`  cleared ${table}`);
    }
  }

  console.log('\nDone. Your login (users table) was left untouched.');
  console.log('Next steps: re-add your mailbox(es), re-verify your domain, rebuild templates, then create your new campaign.\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[reset-data] failed:', e);
    process.exit(1);
  });
