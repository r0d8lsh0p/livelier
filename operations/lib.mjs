// Shared helpers for the bridge instance-flag scripts (opt-out / opt-in /
// set-chat). Connection + row lookup + display only; each script owns its own
// UPDATE.
import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://bridges:bridges@localhost:5544/bridges';

/** Hostname of the target DB, so every run states its blast radius. */
export function dbTarget() {
  try {
    const u = new URL(DATABASE_URL);
    return `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export async function openDb() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * Exact-URL lookup. On a miss, prints near matches (so a typo'd or
 * scheme-less URL is a one-round-trip fix) and returns null.
 */
export async function fetchInstance(client, url) {
  const exact = await client.query('SELECT * FROM bridge_instances WHERE url = $1', [url]);
  if (exact.rows[0]) return exact.rows[0];

  const near = await client.query(
    'SELECT url, name FROM bridge_instances WHERE url ILIKE $1 ORDER BY url LIMIT 5',
    [`%${url.replace(/^https?:\/\//, '')}%`]
  );
  console.error(`No instance with url exactly '${url}'.`);
  if (near.rows.length > 0) {
    console.error('Near matches:');
    for (const r of near.rows) console.error(`  ${r.url}  (${r.name})`);
  }
  return null;
}

export function printRow(label, row) {
  console.log(`${label}:`);
  console.log(`  url:               ${row.url}`);
  console.log(`  name:              ${row.name}`);
  console.log(`  status:            ${row.status} (last_liveness ${row.last_liveness})`);
  console.log(`  discovery_enabled: ${row.discovery_enabled}`);
  console.log(`  chat_enabled:      ${row.chat_enabled}`);
  console.log(`  last_published_at: ${row.last_published_at?.toISOString() ?? 'null'}`);
  console.log(`  profile_hash:      ${row.profile_hash ? 'set' : 'null'}`);
}

export function dryRunFooter() {
  console.log('\nDRY RUN — nothing changed. Re-run with --confirm to execute.');
}
