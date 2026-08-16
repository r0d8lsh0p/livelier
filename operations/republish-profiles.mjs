// Fan existing instance profiles out to the network after
// NETWORK_PROFILE_PUBLISH_ENABLED turns on.
//
// The bridge's kind-0 publishing is hash-gated: a row whose profile content
// hasn't changed is never republished, so flipping the network flag reaches
// only NEW instances. This script clears profile_hash on existing rows; the
// bridge then republishes each one on its next poll cycle to the full
// profile-write set (chat relay + network). The script never publishes
// anything itself — the bridge stays the only writer, so content, signing,
// and hash bookkeeping live in one place.
//
// Pacing: hashes clear in batches with a pause of at least one poll cycle
// between them, so the network relay sees a slow drip of new profiles rather
// than one burst from an unknown author. Ended and discovery-off rows are
// skipped — ended rows catch up naturally when they next come live.
//
// Usage: node operations/republish-profiles.mjs [url] [--confirm]
//        [--batch 15] [--interval-seconds 130]
//   Dry-run by default; --confirm executes. DATABASE_URL selects the target DB.
import { parseArgs } from './lib/arg-parser.mjs';
import { dbTarget, dryRunFooter, openDb } from './lib.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2), {
  booleans: ['--confirm'],
  defaults: { '--batch': '15', '--interval-seconds': '130' },
});
const [onlyUrl] = positional;
const batchSize = Math.max(1, Number(flags['--batch']) || 15);
const intervalMs = Math.max(0, Number(flags['--interval-seconds']) || 130) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const db = await openDb();
try {
  console.log(`Target DB: ${dbTarget()}\n`);

  const eligible = await db.query(
    `SELECT url, name FROM bridge_instances
     WHERE profile_hash IS NOT NULL AND discovery_enabled AND status = 'live'
       AND ($1::text IS NULL OR url = $1)
     ORDER BY url`,
    [onlyUrl ?? null]
  );
  if (eligible.rows.length === 0) {
    console.log(onlyUrl ? `No eligible row with url '${onlyUrl}'.` : 'No eligible rows.');
    process.exit(onlyUrl ? 1 : 0);
  }

  const batches = [];
  for (let i = 0; i < eligible.rows.length; i += batchSize) {
    batches.push(eligible.rows.slice(i, i + batchSize));
  }
  console.log(
    `${eligible.rows.length} live instance profiles to republish in ${batches.length} ` +
      `batch(es) of ≤${batchSize}, ${intervalMs / 1000}s apart ` +
      `(≈${Math.round(((batches.length - 1) * intervalMs) / 60000)} min total).`
  );

  if (!flags['--confirm']) {
    for (const [i, batch] of batches.entries()) {
      console.log(`\nbatch ${i + 1}:`);
      for (const r of batch) console.log(`  ${r.url}  (${r.name})`);
    }
    dryRunFooter();
    process.exit(0);
  }

  for (const [i, batch] of batches.entries()) {
    const updated = await db.query(
      `UPDATE bridge_instances SET profile_hash = NULL, updated_at = now()
       WHERE url = ANY($1) RETURNING url`,
      [batch.map((r) => r.url)]
    );
    console.log(
      `batch ${i + 1}/${batches.length}: cleared ${updated.rows.length} — ` +
        `the bridge republishes them on its next poll cycle`
    );
    if (i < batches.length - 1) await sleep(intervalMs);
  }
  console.log('\nDone. Verify with: node operations/db-status.mjs (last publish moves), and');
  console.log('a kind-0 REQ for a derived npub on the network relay.');
} finally {
  await db.end();
}
