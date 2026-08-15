// One-page read-only summary of the bridge database: migrations applied,
// instance counts by source/status/flag, and snapshot freshness.
//
// This script contains no UPDATE/INSERT/DELETE path at all — it is the safe
// way to interrogate any environment's DB, production included, before
// reaching for one of the flag levers.
//
// Usage: node operations/db-status.mjs
//   DATABASE_URL selects the target DB (default: the local compose stack).
import { dbTarget, openDb } from './lib.mjs';

const db = await openDb();

/** Run a query, or return null when the table doesn't exist yet (fresh DB). */
async function tryQuery(sql) {
  try {
    return await db.query(sql);
  } catch (err) {
    if (err.code === '42P01') return null; // undefined_table
    throw err;
  }
}

try {
  console.log(`Target DB: ${dbTarget()}\n`);

  const migrations = await tryQuery('SELECT version, name FROM schema_migrations ORDER BY version');
  if (!migrations) {
    console.log('schema_migrations: table missing — the bridge has never booted against this DB.');
    process.exit(0);
  }
  console.log('Migrations applied:');
  for (const m of migrations.rows) console.log(`  v${m.version} ${m.name}`);

  const instances = await tryQuery(`
    SELECT source,
           count(*)::int AS total,
           count(*) FILTER (WHERE status = 'live')::int AS live,
           count(*) FILTER (WHERE discovery_enabled)::int AS discovery_on,
           count(*) FILTER (WHERE chat_enabled)::int AS chat_on,
           count(*) FILTER (WHERE origin = 'manual')::int AS manual,
           max(last_published_at) AS last_published,
           min(first_seen_at) AS oldest_row,
           max(first_seen_at) AS newest_row
    FROM bridge_instances
    GROUP BY source ORDER BY source
  `);
  console.log('\nbridge_instances:');
  if (instances.rows.length === 0) {
    console.log('  (empty)');
  }
  for (const r of instances.rows) {
    console.log(
      `  ${r.source}: ${r.total} rows (${r.live} live, ${r.manual} manual) — ` +
        `discovery on for ${r.discovery_on}, chat on for ${r.chat_on}`
    );
    console.log(`    rows first seen ${iso(r.oldest_row)} … ${iso(r.newest_row)}`);
    console.log(`    last publish: ${iso(r.last_published)}`);
  }

  const snapshots = await tryQuery(`
    SELECT count(*)::int AS total, max(captured_at) AS latest FROM live_snapshots
  `);
  const s = snapshots.rows[0];
  console.log(`\nlive_snapshots: ${s.total} rows, latest ${iso(s.latest)}`);
} finally {
  await db.end();
}

function iso(value) {
  return value ? new Date(value).toISOString() : '(never)';
}
