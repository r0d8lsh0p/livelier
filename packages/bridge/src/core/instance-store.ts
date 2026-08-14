import { Pool } from 'pg';
import { InstanceRow } from './types';
import { runMigrations } from './migrations';

/**
 * Postgres-backed state for discovered bridge instances, keyed on instance
 * `url` and scoped by `source` (the network key). Schema is managed by the
 * versioned boot-time migrations in ./migrations — `init()` applies whatever
 * is pending, so operators never run a separate migration step.
 */
export interface LiveSnapshotInput {
  /** Source network key the snapshot belongs to. */
  source: string;
  /** Raw directory objects of the live set at capture time. */
  raw: unknown[];
  /** Live count as reported by the directory (pre-NSFW-filter). */
  directoryLiveCount: number;
  /** Live count actually bridged this cycle (post-filter). */
  bridgedLiveCount: number;
  hlsLive: number;
  hlsEnded: number;
  hlsError: number;
  schemaVersion: string;
}

export interface UpsertSeenInput {
  url: string;
  /** Source network key ('owncast', …). */
  source: string;
  pubkey: string;
  d_tag: string;
  name: string;
  stream_title: string;
  description: string;
  image: string;
  nsfw: boolean;
  starts_at: Date | null;
  hls_url: string;
  /**
   * Posture stamped onto NEW rows only (inside the INSERT, so no fail-closed
   * window). Existing rows are never swept to match — explicit per-row
   * settings (test enables, opt-outs) always stick.
   */
  discovery_enabled: boolean;
  chat_enabled: boolean;
}

export class InstanceStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await runMigrations(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Insert a freshly-discovered instance or refresh its metadata + last_seen.
   * Does not change status/failure counters — liveness owns those.
   * Returns true when the row was newly created.
   */
  async upsertSeen(input: UpsertSeenInput): Promise<{ row: InstanceRow; isNew: boolean }> {
    const result = await this.pool.query<InstanceRow & { is_new: boolean }>(
      `
      INSERT INTO bridge_instances
        (url, source, origin, pubkey, d_tag, name, stream_title, description, image, nsfw, starts_at, hls_url, discovery_enabled, chat_enabled)
      VALUES ($1,$2,'discovered',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (url) DO UPDATE SET
        source = EXCLUDED.source,
        d_tag = EXCLUDED.d_tag,
        name = EXCLUDED.name,
        stream_title = EXCLUDED.stream_title,
        description = EXCLUDED.description,
        image = EXCLUDED.image,
        nsfw = EXCLUDED.nsfw,
        starts_at = EXCLUDED.starts_at,
        hls_url = EXCLUDED.hls_url,
        last_seen_at = now(),
        updated_at = now()
      RETURNING *, (xmax = 0) AS is_new
      `,
      [
        input.url,
        input.source,
        input.pubkey,
        input.d_tag,
        input.name,
        input.stream_title,
        input.description,
        input.image,
        input.nsfw,
        input.starts_at,
        input.hls_url,
        input.discovery_enabled,
        input.chat_enabled,
      ]
    );
    const row = result.rows[0];
    return { row, isNew: row.is_new };
  }

  async get(url: string): Promise<InstanceRow | null> {
    const result = await this.pool.query<InstanceRow>(
      'SELECT * FROM bridge_instances WHERE url = $1',
      [url]
    );
    return result.rows[0] ?? null;
  }

  async listByStatus(status: 'live' | 'ended', source: string): Promise<InstanceRow[]> {
    const result = await this.pool.query<InstanceRow>(
      'SELECT * FROM bridge_instances WHERE status = $1 AND source = $2',
      [status, source]
    );
    return result.rows;
  }

  /** Manually-added instances (local test fleets) for one source network. */
  async listManual(source: string): Promise<InstanceRow[]> {
    const result = await this.pool.query<InstanceRow>(
      "SELECT * FROM bridge_instances WHERE source = $1 AND origin = 'manual'",
      [source]
    );
    return result.rows;
  }

  /**
   * The chat allowlist: rooms the chat bridge should be connected to.
   * Requires discovery_enabled — an opted-out instance has no 30311 on the
   * relays, so there is no room to bridge regardless of chat_enabled.
   */
  async listChatRooms(source: string): Promise<InstanceRow[]> {
    const result = await this.pool.query<InstanceRow>(
      "SELECT * FROM bridge_instances WHERE chat_enabled AND discovery_enabled AND status = 'live' AND source = $1",
      [source]
    );
    return result.rows;
  }

  /** Update a subset of mutable columns. */
  async update(url: string, fields: Partial<Omit<InstanceRow, 'url'>>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => (fields as Record<string, unknown>)[k]);
    await this.pool.query(
      `UPDATE bridge_instances SET ${set}, updated_at = now() WHERE url = $1`,
      [url, ...values]
    );
  }

  /** Insert an hourly observation snapshot of the presently-live set. */
  async insertLiveSnapshot(input: LiveSnapshotInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO live_snapshots
        (source, directory_live_count, bridged_live_count, hls_live, hls_ended, hls_error, schema_version, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.source,
        input.directoryLiveCount,
        input.bridgedLiveCount,
        input.hlsLive,
        input.hlsEnded,
        input.hlsError,
        input.schemaVersion,
        JSON.stringify(input.raw),
      ]
    );
  }

  /** Most recent snapshot time, so a restart doesn't reset the hourly cadence. */
  async latestSnapshotAt(source: string): Promise<Date | null> {
    const result = await this.pool.query<{ captured_at: Date }>(
      'SELECT captured_at FROM live_snapshots WHERE source = $1 ORDER BY captured_at DESC LIMIT 1',
      [source]
    );
    return result.rows[0]?.captured_at ?? null;
  }

  /** Counts by status, for the observation metrics. */
  async statusCounts(): Promise<{ live: number; ended: number; total: number }> {
    const result = await this.pool.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*)::text AS count FROM bridge_instances GROUP BY status'
    );
    let live = 0;
    let ended = 0;
    for (const r of result.rows) {
      if (r.status === 'live') live = Number(r.count);
      if (r.status === 'ended') ended = Number(r.count);
    }
    return { live, ended, total: live + ended };
  }
}
