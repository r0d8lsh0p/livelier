// Flip a bridged instance's discovery flag.
//
//   off — the poller stops probing and publishing this instance entirely.
//         Already-published events REMAIN on the relays ("stop bridging
//         forward, keep the history"); to also remove them, run
//         `npx ts-node -P packages/bridge/tsconfig.json operations/retract-instance.ts`.
//         Chat rooms close too (a room requires discovery), but chat_enabled
//         itself is untouched.
//   on  — rejoins discovery on the next poll cycle, republishing under the
//         SAME derived npub and d-tag.
//
// Usage: node operations/set-discovery.mjs <url> on|off [--confirm]
//   Dry-run by default; --confirm executes. DATABASE_URL selects the target DB.
import { parseArgs } from './lib/arg-parser.mjs';
import { dbTarget, dryRunFooter, fetchInstance, openDb, printRow } from './lib.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2), {
  booleans: ['--confirm'],
});
const [url, mode] = positional;

if (!url || (mode !== 'on' && mode !== 'off')) {
  console.error('Usage: node operations/set-discovery.mjs <url> on|off [--confirm]');
  process.exit(2);
}
const enabled = mode === 'on';

const db = await openDb();
try {
  console.log(`Target DB: ${dbTarget()}\n`);
  const row = await fetchInstance(db, url);
  if (!row) process.exit(1);

  printRow('Current', row);
  console.log(`\nPlanned: discovery_enabled=${enabled}.`);
  if (enabled) {
    console.log('Effect: republished on the next poll cycle if live — same npub + d-tag.');
  } else {
    console.log('Effect: probes and publishes stop within one poll cycle; any open chat');
    console.log('room closes. Already-published events REMAIN on the relays — to remove');
    console.log('them too: npx ts-node -P packages/bridge/tsconfig.json operations/retract-instance.ts <url> --confirm');
  }

  if (!flags['--confirm']) {
    dryRunFooter();
    process.exit(0);
  }

  const updated = await db.query(
    `UPDATE bridge_instances
     SET discovery_enabled = $2, updated_at = now()
     WHERE url = $1
     RETURNING *`,
    [url, enabled]
  );
  console.log('');
  printRow('Updated', updated.rows[0]);
} finally {
  await db.end();
}
