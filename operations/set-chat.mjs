// Flip the per-room chat allowlist flag. The chat bridge reconciles rooms
// every 30s, so this takes effect without a deploy — it is both the staged
// rollout lever and the per-room kill switch.
//
// Usage: node operations/set-chat.mjs <url> on|off [--confirm]
//        node operations/set-chat.mjs --all on|off [--confirm] [--source owncast]
//   Dry-run by default; --confirm executes. DATABASE_URL selects the target DB.
//
// --all is the deliberate fleet-wide sweep the poller never performs on its
// own: posture env vars stamp NEW rows only, so opening (or closing) chat for
// rows that already exist is always an explicit operator act. It prints a
// per-source census of what would change before it changes anything.
import { parseArgs } from './lib/arg-parser.mjs';
import { dbTarget, dryRunFooter, fetchInstance, openDb, printRow } from './lib.mjs';

const USAGE = [
  'Usage: node operations/set-chat.mjs <url> on|off [--confirm]',
  '       node operations/set-chat.mjs --all on|off [--confirm] [--source <key>]',
].join('\n');

const { flags, positional } = parseArgs(process.argv.slice(2), {
  booleans: ['--confirm', '--all'],
});
const all = flags['--all'] === true;
const source = typeof flags['--source'] === 'string' ? flags['--source'] : null;
const [first, second] = positional;
const mode = all ? first : second;
const url = all ? null : first;

if (all && positional.length > 1) {
  // A stray url alongside --all would silently widen the blast radius.
  console.error('--all takes no <url> — it targets every row. Drop one or the other.');
  process.exit(2);
}
if (mode !== 'on' && mode !== 'off') {
  console.error(USAGE);
  process.exit(2);
}
if (!all && !url) {
  console.error(USAGE);
  process.exit(2);
}
const enabled = mode === 'on';

const db = await openDb();
try {
  console.log(`Target DB: ${dbTarget()}\n`);
  await (all ? setAll() : setOne());
} finally {
  await db.end();
}

async function setOne() {
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
  printEffect();

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
}

async function setAll() {
  const census = await db.query(
    `SELECT source,
            count(*)::int AS total,
            count(*) FILTER (WHERE chat_enabled IS DISTINCT FROM $1)::int AS changing,
            count(*) FILTER (WHERE chat_enabled IS DISTINCT FROM $1
                               AND status = 'live' AND discovery_enabled)::int AS changing_live,
            count(*) FILTER (WHERE chat_enabled IS DISTINCT FROM $1
                               AND NOT discovery_enabled)::int AS changing_inert
     FROM bridge_instances
     WHERE ($2::text IS NULL OR source = $2)
     GROUP BY source ORDER BY source`,
    [enabled, source]
  );

  if (census.rows.length === 0) {
    console.log(source ? `No rows with source '${source}'.` : 'bridge_instances is empty.');
    process.exit(source ? 1 : 0);
  }

  const scope = source ? `source '${source}'` : 'ALL sources';
  console.log(`Scope: every row of ${scope}.\n`);

  let changing = 0;
  let changingLive = 0;
  let changingInert = 0;
  for (const r of census.rows) {
    changing += r.changing;
    changingLive += r.changing_live;
    changingInert += r.changing_inert;
    console.log(
      `  ${r.source}: ${r.total} rows — ${r.changing} would change, ` +
        `${r.total - r.changing} already chat_enabled=${enabled}`
    );
  }

  console.log(`\nPlanned: chat_enabled=${enabled} on ${changing} row(s).`);
  if (changing === 0) {
    console.log('Nothing to do — every row in scope is already at that setting.');
    process.exit(0);
  }
  if (enabled) {
    console.log(
      `Of those, ${changingLive} are live with discovery on — their rooms open on the ` +
        'next reconcile;'
    );
    console.log('the rest open when they next go live.');
    if (changingInert > 0) {
      console.log(
        `WARNING: ${changingInert} row(s) have discovery off — chat_enabled is inert for ` +
          'them until'
      );
      console.log('set-discovery.mjs turns discovery back on (rooms require discovery).');
    }
  } else {
    console.log(`Of those, ${changingLive} have a room open now — it closes on the next reconcile.`);
  }
  printEffect();

  if (!flags['--confirm']) {
    dryRunFooter();
    process.exit(0);
  }

  const updated = await db.query(
    `UPDATE bridge_instances SET chat_enabled = $1, updated_at = now()
     WHERE chat_enabled IS DISTINCT FROM $1 AND ($2::text IS NULL OR source = $2)
     RETURNING url`,
    [enabled, source]
  );
  console.log(`\nUpdated ${updated.rowCount} row(s) to chat_enabled=${enabled}.`);
}

function printEffect() {
  console.log('Effect: chat bridge reconciles within ~30s (no deploy). Direction gates');
  console.log('(OWNCAST_CHAT_TO_NOSTR / OWNCAST_CHAT_FROM_NOSTR) must also be on.');
}
