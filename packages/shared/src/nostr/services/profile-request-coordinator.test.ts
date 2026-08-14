/**
 * Unit tests for the shared ProfileRequestCoordinator singleton.
 *
 * These exercise the coordination behaviour that fixes the "too many concurrent
 * REQs" regression: one batched fetch per set of wanted pubkeys, cross-caller
 * in-flight dedup, and a bounded backoff ledger that converges globally (so a
 * missing profile is not re-queried forever by every surface).
 */
import type { Event } from 'nostr-tools';

// Map-backed fake of the shared profile cache (coordinator imports this path).
const cacheMap = new Map<string, unknown>();
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
  },
}));

const fetchProfileEvents = jest.fn<Promise<(Event | undefined)[]>, [string[]]>();
const clearProfileEvent = jest.fn<void, [string]>();
jest.mock('./client.service', () => ({
  __esModule: true,
  default: {
    fetchProfileEvents: (pubkeys: string[]) => fetchProfileEvents(pubkeys),
    clearProfileEvent: (pubkey: string) => clearProfileEvent(pubkey),
  },
}));

// In-memory fake of the persistent negative cache (no storage, no timers).
const persistedMisses = new Set<string>();
const recordMiss = jest.fn((pk: string) => {
  persistedMisses.add(pk);
});
const clearMiss = jest.fn((pk: string) => {
  persistedMisses.delete(pk);
});
jest.mock('./profile-miss-cache', () => ({
  __esModule: true,
  default: {
    hydrate: jest.fn(async () => []),
    recordMiss: (pk: string) => recordMiss(pk),
    clearMiss: (pk: string) => clearMiss(pk),
    hasMiss: (pk: string) => persistedMisses.has(pk),
    resetForTesting: () => persistedMisses.clear(),
  },
}));

import coordinator from './profile-request-coordinator';

/** A kind-0 event whose parsed profile has the given name. */
function kind0(pubkey: string, name: string): Event {
  return {
    id: `id-${pubkey}`,
    pubkey,
    created_at: 1,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name, picture: `https://x/${name}.png` }),
    sig: '',
  } as Event;
}

/** Let queued microtasks (the fetch promise chain) settle. */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  cacheMap.clear();
  fetchProfileEvents.mockReset();
  clearProfileEvent.mockClear();
  recordMiss.mockClear();
  clearMiss.mockClear();
  persistedMisses.clear();
  coordinator.resetForTesting();
});

describe('ProfileRequestCoordinator', () => {
  it('retain fetches missing pubkeys in one batch and caches found profiles', async () => {
    fetchProfileEvents.mockResolvedValueOnce([kind0('pk_a', 'Alice')]);

    const release = coordinator.retain(['pk_a']);
    await flushMicrotasks();

    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);
    expect(fetchProfileEvents).toHaveBeenCalledWith(['pk_a']);
    expect(coordinator.readKnown(['pk_a'])).toEqual({
      pk_a: expect.objectContaining({ name: 'Alice', picture: 'https://x/Alice.png' }),
    });
    release();
  });

  it('dedupes: two callers wanting the same pubkey trigger only one fetch', async () => {
    let resolveFetch!: (events: (Event | undefined)[]) => void;
    fetchProfileEvents.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r;
      }),
    );

    const release1 = coordinator.retain(['pk_a']); // starts the fetch (in-flight)
    const release2 = coordinator.retain(['pk_a']); // joins while in-flight — no 2nd fetch

    resolveFetch([kind0('pk_a', 'Alice')]);
    await flushMicrotasks();

    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);
    release1();
    release2();
  });

  it('does not re-fetch a pubkey already resolved in cache', async () => {
    cacheMap.set('pk_a', { name: 'Cached', picture: null });

    const release = coordinator.retain(['pk_a']);
    await flushMicrotasks();

    expect(fetchProfileEvents).not.toHaveBeenCalled();
    expect(coordinator.readKnown(['pk_a'])).toEqual({ pk_a: { name: 'Cached', picture: null } });
    release();
  });

  it('records a bounded backoff for a missing profile and does not immediately re-fetch it', async () => {
    fetchProfileEvents.mockResolvedValue([undefined]); // relay returns nothing

    const release1 = coordinator.retain(['pk_missing']);
    await flushMicrotasks();
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    // A fresh surface wants the same pubkey while it is in cooldown → no refetch.
    const release2 = coordinator.retain(['pk_missing']);
    await flushMicrotasks();
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    expect(coordinator.readKnown(['pk_missing'])).toEqual({});
    release1();
    release2();
  });

  it('getProfiles resolves cached results and returns null for the unresolved', async () => {
    fetchProfileEvents.mockResolvedValueOnce([kind0('pk_a', 'Alice'), undefined]);

    const result = await coordinator.getProfiles(['pk_a', 'pk_b']);

    expect(result.pk_a).toEqual(expect.objectContaining({ name: 'Alice', picture: 'https://x/Alice.png' }));
    expect(result.pk_b).toBeNull();
  });

  it('getProfile is getProfiles of length one', async () => {
    fetchProfileEvents.mockResolvedValueOnce([kind0('pk_a', 'Alice')]);
    const profile = await coordinator.getProfile('pk_a');
    expect(profile).toEqual(expect.objectContaining({ name: 'Alice', picture: 'https://x/Alice.png' }));
  });

  it('clears the persistent negative cache when a profile is found', async () => {
    persistedMisses.add('pk_a');
    fetchProfileEvents.mockResolvedValueOnce([kind0('pk_a', 'Alice')]);

    const release = coordinator.retain(['pk_a']);
    await flushMicrotasks();

    expect(clearMiss).toHaveBeenCalledWith('pk_a');
    release();
  });

  it('refreshProfiles bypasses caches and ledgers and refetches from relays', async () => {
    // Wrongly negative-cached pubkey plus a stale positive-cache entry.
    persistedMisses.add('pk_a');
    cacheMap.set('pk_a', { name: 'Stale', picture: null });
    fetchProfileEvents.mockResolvedValueOnce([kind0('pk_a', 'Fresh')]);

    const result = await coordinator.refreshProfiles(['pk_a']);

    expect(clearMiss).toHaveBeenCalledWith('pk_a');
    expect(clearProfileEvent).toHaveBeenCalledWith('pk_a');
    expect(fetchProfileEvents).toHaveBeenCalledWith(['pk_a']);
    expect(result.pk_a).toEqual(expect.objectContaining({ name: 'Fresh' }));
    expect(cacheMap.get('pk_a')).toEqual(expect.objectContaining({ name: 'Fresh' }));
  });

  it('boot aggregation window coalesces serial demand into ONE batched fetch', async () => {
    fetchProfileEvents.mockResolvedValueOnce([kind0('pk_a', 'Alice'), kind0('pk_b', 'Bob')]);
    coordinator.beginBootWindowForTesting(60);

    // Boot surfaces mount one after another — without the window each
    // retain dispatched its own single-author REQ.
    const release1 = coordinator.retain(['pk_a']);
    await flushMicrotasks();
    const release2 = coordinator.retain(['pk_b']);
    await flushMicrotasks();

    expect(fetchProfileEvents).not.toHaveBeenCalled();

    // Window ends → one coalesced dispatch with both authors.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);
    expect(fetchProfileEvents).toHaveBeenCalledWith(['pk_a', 'pk_b']);

    release1();
    release2();
  });

  it('refreshProfiles restores the previous profile when the refetch is empty', async () => {
    cacheMap.set('pk_a', { name: 'Existing', picture: null, timestamp: 1 });
    fetchProfileEvents.mockResolvedValueOnce([undefined]);

    const result = await coordinator.refreshProfiles(['pk_a']);

    // The refetch found nothing — the cached profile must not be lost.
    expect(result.pk_a).toEqual(expect.objectContaining({ name: 'Existing' }));
    expect(cacheMap.get('pk_a')).toEqual(expect.objectContaining({ name: 'Existing' }));
  });
});
