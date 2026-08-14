import { Pool } from 'pg';

/**
 * Versioned schema migrations, applied automatically at boot.
 *
 * The operator experience stays zero-ops (`docker compose up` and the schema
 * exists), but every change is an ordered, tracked step: applied versions are
 * recorded in `schema_migrations`, pending ones run in order inside a
 * transaction each, and a Postgres advisory lock serializes concurrent boots.
 *
 * Rules for adding a migration:
 * - Append only. Never edit or reorder a shipped migration — installations in
 *   the wild have already recorded its version as applied.
 * - One concern per migration, plain SQL, no data imports.
 * - Migrations must not assume anything about deployment history beyond the
 *   previous migration's end state.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
-- Instance state for every bridged source network. 'source' is the network
-- key ('owncast', ...); 'origin' is provenance ('discovered' from the
-- source's live feed, 'manual' for hand-added instances). This DB is a
-- working cache — the durable record is the relay.
CREATE TABLE bridge_instances (
  url                  text PRIMARY KEY,
  source               text NOT NULL,
  origin               text NOT NULL DEFAULT 'discovered',
  pubkey               text NOT NULL,
  d_tag                text NOT NULL,
  name                 text NOT NULL DEFAULT '',
  stream_title         text NOT NULL DEFAULT '',
  description          text NOT NULL DEFAULT '',
  image                text NOT NULL DEFAULT '',
  nsfw                 boolean NOT NULL DEFAULT false,
  starts_at            timestamptz,
  status               text NOT NULL DEFAULT 'live' CHECK (status IN ('live','ended')),
  hls_url              text NOT NULL DEFAULT '',
  last_liveness        text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  profile_hash         text,
  chat_enabled         boolean NOT NULL DEFAULT false,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_published_at    timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bridge_instances_status ON bridge_instances (status);
CREATE INDEX idx_bridge_instances_source ON bridge_instances (source);

-- Hourly observation snapshots: the raw source JSON of the presently-live
-- set, plus that cycle's liveness numbers. Reporting data only — never
-- Nostr events; events live on the relay.
CREATE TABLE live_snapshots (
  id                   bigserial PRIMARY KEY,
  source               text NOT NULL,
  captured_at          timestamptz NOT NULL DEFAULT now(),
  directory_live_count integer NOT NULL,
  bridged_live_count   integer NOT NULL,
  hls_live             integer NOT NULL,
  hls_ended            integer NOT NULL,
  hls_error            integer NOT NULL,
  schema_version       text NOT NULL,
  raw                  jsonb NOT NULL
);
CREATE INDEX idx_live_snapshots_captured_at ON live_snapshots (captured_at);
`,
  },
  {
    version: 2,
    name: 'per-instance-discovery-flag',
    sql: `
-- Per-instance publish permission, symmetric with chat_enabled.
--
-- discovery_enabled: false means the poller stops touching this instance —
-- no 30311s, no kind-0, no liveness probes. The DB still tracks it (the row
-- must survive so rediscovery cannot re-publish it), and anything already
-- published stays on the relays; removal is a separate manual operator
-- action. The DB DEFAULT false is a fail-closed net only: the engine stamps
-- the real value (from the source's default-posture config) inside the
-- INSERT, and nothing ever sweeps existing rows to match config — explicit
-- per-row settings always stick.
ALTER TABLE bridge_instances
  ADD COLUMN discovery_enabled boolean NOT NULL DEFAULT false;

-- Rows that exist before this migration were all published under the
-- pre-flag behavior; grandfather them in so the retraction pass does not
-- tear down the whole fleet. No-op on fresh installs.
UPDATE bridge_instances SET discovery_enabled = true;
`,
  },
  {
    version: 3,
    name: 'viewer-count',
    sql: `
-- Last PUBLISHED viewer count (NIP-53 current_participants), per instance.
-- NULL = the instance hides its count (or none published yet). The engine
-- compares each poll's count against this to publish-on-change between
-- heartbeats, so the 30311 stays reasonably current.
ALTER TABLE bridge_instances
  ADD COLUMN viewer_count integer;
`,
  },
];

/** Advisory lock key serializing migration runs across concurrent boots. */
const MIGRATION_LOCK_KEY = 1172; // arbitrary stable app-specific lock key; any stable int works

/** The not-yet-applied subset, in version order. Pure — exported for tests. */
export function pendingMigrations(all: Migration[], applied: Set<number>): Migration[] {
  return [...all].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));
}

/**
 * Apply all pending migrations. Returns how many ran. Throws on the first
 * failure (after rolling back that migration) so the process fails fast
 * rather than running against a half-migrated schema.
 */
export async function runMigrations(
  pool: Pool,
  migrations: Migration[] = MIGRATIONS
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(result.rows.map((r) => r.version));
    const pending = pendingMigrations(migrations, applied);

    for (const migration of pending) {
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`migration ${migration.version} (${migration.name}) failed: ${reason}`);
      }
    }
    return pending.length;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
