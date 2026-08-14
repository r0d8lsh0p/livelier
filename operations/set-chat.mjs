// Flip the per-room chat allowlist flag. The chat bridge reconciles rooms
// every 30s, so this takes effect without a deploy — it is both the staged
// rollout lever and the per-room kill switch.
//
// Usage: node operations/set-chat.mjs <url> on|off [--confirm]
//   Dry-run by default; --confirm executes. DATABASE_URL selects the target DB.
import { parseArgs } from './lib/arg-parser.mjs';
import { dbTarget, dryRunFooter, fetchInstance, openDb, printRow } from './lib.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2), {
  booleans: ['--confirm'],
});
const [url, mode] = positional;

if (!url || (mode !== 'on' && mode !== 'off')) {
  console.error('Usage: node operations/set-chat.mjs <url> on|off [--confirm]');
  process.exit(2);
}
const enabled = mode === 'on';

const db = await openDb();
try {
  console.log(`Target DB: ${dbTarget()}\n`);
  const row = await fetchInstance(db, url);
  if (!row) process.exit(1);

  printRow('Current', row);
  console.log(`\nPlanned: chat_enabled=${enabled}.`);
  if (enabled && !row.discovery_enabled) {
    console.log('WARNING: discovery is off for this instance — chat_enabled is inert');
    console.log('until set-discovery.mjs turns it back on (rooms require discovery).');
  }
  if (enabled && row.status !== 'live') {
    console.log(`Note: status is '${row.status}'; the room opens when the instance next goes live.`);
  }
  console.log('Effect: chat bridge reconciles within ~30s (no deploy). Direction gates');
  console.log('(OWNCAST_CHAT_TO_NOSTR / OWNCAST_CHAT_FROM_NOSTR) must also be on.');

  if (!flags['--confirm']) {
    dryRunFooter();
    process.exit(0);
  }

  const updated = await db.query(
    'UPDATE bridge_instances SET chat_enabled = $2, updated_at = now() WHERE url = $1 RETURNING *',
    [url, enabled]
  );
  console.log('');
  printRow('Updated', updated.rows[0]);
} finally {
  await db.end();
}
