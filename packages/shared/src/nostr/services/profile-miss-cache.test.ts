/**
 * Unit tests for the persistent profile negative cache.
 *
 * The contract under test: misses persist across "sessions" (hydrate), but
 * are never permanent — entries expire after PROFILE_MISS_TTL_MS, and
 * clearMiss() (found profile / force refresh) removes them immediately.
 */

// In-memory fake of SecureStorageService (module-level singleton import).
const storageMap = new Map<string, string>();
jest.mock('../../storage/secure-storage.service', () => ({
  __esModule: true,
  default: {
    isAvailable: jest.fn(async () => true),
    getItem: jest.fn(async (key: string) => storageMap.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      storageMap.set(key, value);
    }),
    deleteItem: jest.fn(async (key: string) => {
      storageMap.delete(key);
    }),
  },
}));

import profileMissCache, { PROFILE_MISS_TTL_MS } from './profile-miss-cache';
import { STORAGE_KEYS } from '../../storage/config';

/** Run the debounced save (500ms) and let its async body settle. */
async function settleSave() {
  await jest.advanceTimersByTimeAsync(600);
}

beforeEach(() => {
  jest.useFakeTimers();
  storageMap.clear();
  profileMissCache.resetForTesting();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ProfileMissCache', () => {
  it('records a miss, persists it, and hydrates it back within TTL', async () => {
    profileMissCache.recordMiss('pk_a', 1_000_000);
    expect(profileMissCache.hasMiss('pk_a', 1_000_001)).toBe(true);
    await settleSave();

    expect(storageMap.has(STORAGE_KEYS.PROFILE_MISS_CACHE)).toBe(true);

    // Simulate a fresh session: in-memory state gone, storage intact.
    profileMissCache.resetForTesting();
    expect(profileMissCache.hasMiss('pk_a', 1_000_001)).toBe(false);

    const alive = await profileMissCache.hydrate(1_000_000 + PROFILE_MISS_TTL_MS / 2);
    expect(alive).toEqual(['pk_a']);
    expect(profileMissCache.hasMiss('pk_a', 1_000_000 + PROFILE_MISS_TTL_MS / 2)).toBe(true);
  });

  it('expires misses after the TTL — a miss is never permanent', async () => {
    profileMissCache.recordMiss('pk_a', 1_000_000);
    await settleSave();

    profileMissCache.resetForTesting();
    const alive = await profileMissCache.hydrate(1_000_000 + PROFILE_MISS_TTL_MS + 1);
    expect(alive).toEqual([]);
  });

  it('hasMiss drops an entry that crossed the TTL mid-session', () => {
    profileMissCache.recordMiss('pk_a', 1_000_000);
    expect(profileMissCache.hasMiss('pk_a', 1_000_000 + PROFILE_MISS_TTL_MS + 1)).toBe(false);
  });

  it('clearMiss removes the entry immediately (found profile / force refresh)', async () => {
    profileMissCache.recordMiss('pk_a', 1_000_000);
    profileMissCache.clearMiss('pk_a');
    expect(profileMissCache.hasMiss('pk_a', 1_000_001)).toBe(false);
    await settleSave();

    profileMissCache.resetForTesting();
    const alive = await profileMissCache.hydrate(1_000_001);
    expect(alive).toEqual([]);
  });

  it('hydrate survives corrupt storage without throwing', async () => {
    storageMap.set(STORAGE_KEYS.PROFILE_MISS_CACHE, 'not json{');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const alive = await profileMissCache.hydrate();
    expect(alive).toEqual([]);
    warnSpy.mockRestore();
  });
});
