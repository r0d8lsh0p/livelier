import { MIGRATIONS, Migration, pendingMigrations, runMigrations } from './migrations';

describe('MIGRATIONS registry', () => {
  it('has strictly ascending, unique versions starting at 1', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions[0]).toBe(1);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('every migration has a name and non-empty SQL', () => {
    for (const m of MIGRATIONS) {
      expect(m.name).toMatch(/^[a-z0-9-]+$/);
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('pendingMigrations', () => {
  const all: Migration[] = [
    { version: 2, name: 'two', sql: 'B' },
    { version: 1, name: 'one', sql: 'A' },
    { version: 3, name: 'three', sql: 'C' },
  ];

  it('returns unapplied migrations in version order', () => {
    expect(pendingMigrations(all, new Set()).map((m) => m.version)).toEqual([1, 2, 3]);
    expect(pendingMigrations(all, new Set([1])).map((m) => m.version)).toEqual([2, 3]);
    expect(pendingMigrations(all, new Set([1, 2, 3]))).toEqual([]);
  });
});

/** Fake pg client recording queries; applied versions are configurable. */
function makeFakePool(appliedVersions: number[], failOnSql?: string) {
  const queries: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (failOnSql && sql === failOnSql) throw new Error('boom');
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: appliedVersions.map((v) => ({ version: v })) };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) };
  return { pool, client, queries };
}

describe('runMigrations', () => {
  const migrations: Migration[] = [
    { version: 1, name: 'one', sql: 'CREATE-ONE' },
    { version: 2, name: 'two', sql: 'CREATE-TWO' },
  ];

  it('applies only pending migrations, each in a transaction, under the advisory lock', async () => {
    const { pool, client, queries } = makeFakePool([1]);
    const ran = await runMigrations(pool as never, migrations);

    expect(ran).toBe(1);
    expect(queries.some((q) => q.includes('pg_advisory_lock'))).toBe(true);
    expect(queries).not.toContain('CREATE-ONE'); // already applied
    const begin = queries.indexOf('BEGIN');
    expect(queries[begin + 1]).toBe('CREATE-TWO');
    expect(queries).toContain('COMMIT');
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('is a no-op when everything is applied', async () => {
    const { pool, queries } = makeFakePool([1, 2]);
    const ran = await runMigrations(pool as never, migrations);
    expect(ran).toBe(0);
    expect(queries).not.toContain('BEGIN');
  });

  it('rolls back, unlocks, and throws with the failing version on error', async () => {
    const { pool, client, queries } = makeFakePool([], 'CREATE-TWO');
    await expect(runMigrations(pool as never, migrations)).rejects.toThrow(
      'migration 2 (two) failed: boom'
    );
    expect(queries).toContain('ROLLBACK');
    // Migration 1 committed before the failure — partial progress is kept.
    expect(queries).toContain('CREATE-ONE');
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});
