/**
 * The fs adapter backs the persistent profile caches — a broken adapter
 * silently degrades every boot to cold-cache, so pin the round-trip.
 */
import storageAdapter from './storage';

describe('node fs storage adapter', () => {
  const key = `test_key_${process.pid}_${Date.now()}`;

  afterEach(async () => {
    await storageAdapter.deleteItem(key);
  });

  it('is available', async () => {
    await expect(storageAdapter.isAvailable()).resolves.toBe(true);
  });

  it('round-trips a value', async () => {
    await storageAdapter.setItem(key, '{"hello":"world"}');
    await expect(storageAdapter.getItem(key)).resolves.toBe('{"hello":"world"}');
  });

  it('returns null for a missing key and tolerates deleting one', async () => {
    await expect(storageAdapter.getItem('never_written_' + key)).resolves.toBeNull();
    await expect(storageAdapter.deleteItem('never_written_' + key)).resolves.toBeUndefined();
  });

  it('overwrites atomically', async () => {
    await storageAdapter.setItem(key, 'one');
    await storageAdapter.setItem(key, 'two');
    await expect(storageAdapter.getItem(key)).resolves.toBe('two');
  });

  it('concurrent writes to one key end with a complete value, never corruption', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storageAdapter.setItem(key, JSON.stringify({ i })))
    );
    const final = await storageAdapter.getItem(key);
    expect(final).not.toBeNull();
    expect(() => JSON.parse(final as string)).not.toThrow();
  });

  it('reports unavailable (and setItem rejects) for an unwritable STORAGE_DIR', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelier-ro-'));
    fs.chmodSync(dir, 0o500);
    const prev = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = path.join(dir, 'nested');
    try {
      let roAdapter: typeof storageAdapter;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        roAdapter = require('./storage').default;
      });
      await expect(roAdapter!.isAvailable()).resolves.toBe(false);
      await expect(roAdapter!.setItem('k', 'v')).rejects.toThrow();
    } finally {
      process.env.STORAGE_DIR = prev;
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
