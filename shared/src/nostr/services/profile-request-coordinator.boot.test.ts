/**
 * Cold-boot hydration gate for the ProfileRequestCoordinator.
 *
 * The persisted profile cache loads asynchronously, but partitioning reads
 * it synchronously — so dispatches that ran before hydration finished
 * refetched every profile that was already on disk, making every warm boot
 * cost as much as a cold one (measured: 51 of 55 boot REQs were kind-0
 * lookups). The coordinator must hold its first dispatch until both
 * persisted caches (positive + negative) have hydrated.
 *
 * Uses isolateModules because the singleton captures its hydration promise
 * at construction (import time).
 */
import type { Event } from 'nostr-tools';

const cacheMap = new Map<string, unknown>();
let resolveCacheReady!: () => void;
const cacheReady = new Promise<void>((resolve) => {
  resolveCacheReady = resolve;
});

jest.mock('../../services/ProfileCacheService', () => ({
  __esModule: true,
  default: {
    hasProfile: (pk: string) => cacheMap.has(pk),
    getProfile: (pk: string) => cacheMap.get(pk) ?? null,
    storeProfile: (pk: string, profile: unknown) => {
      cacheMap.set(pk, profile);
    },
    removeProfile: (pk: string) => {
      cacheMap.delete(pk);
    },
    whenInitialized: () => cacheReady,
  },
}));

const fetchProfileEvents = jest.fn<Promise<(Event | undefined)[]>, [string[]]>();
jest.mock('./client.service', () => ({
  __esModule: true,
  default: {
    fetchProfileEvents: (pubkeys: string[]) => fetchProfileEvents(pubkeys),
    clearProfileEvent: jest.fn(),
  },
}));

jest.mock('./profile-miss-cache', () => ({
  __esModule: true,
  default: {
    hydrate: jest.fn(async () => []),
    recordMiss: jest.fn(),
    clearMiss: jest.fn(),
    hasMiss: jest.fn(() => false),
  },
}));

import coordinator from './profile-request-coordinator';

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe('ProfileRequestCoordinator cold-boot hydration gate', () => {
  it('holds dispatch until the persisted cache hydrates, then serves from it (warm boot = no refetch)', async () => {
    // Zero the boot aggregation window; this test isolates the hydration gate.
    coordinator.beginBootWindowForTesting(0);

    // Boot: a surface wants a profile BEFORE the disk cache finished loading.
    const release = coordinator.retain(['pk_warm']);
    await flushMicrotasks();

    // No dispatch yet — hydration is pending.
    expect(fetchProfileEvents).not.toHaveBeenCalled();

    // Hydration completes and the profile was on disk all along.
    cacheMap.set('pk_warm', { name: 'Warm', picture: null });
    resolveCacheReady();
    await flushMicrotasks();

    // Served from the cache — the warm boot cost zero relay REQs.
    expect(fetchProfileEvents).not.toHaveBeenCalled();
    expect(coordinator.readKnown(['pk_warm'])).toEqual({
      pk_warm: { name: 'Warm', picture: null },
    });

    release();
  });
});
