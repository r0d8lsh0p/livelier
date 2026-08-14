/**
 * Early-arrival profile application and the boot fast-retry lane.
 *
 * The client streams replaceable events per relay delivery (before the
 * batch's slowest relay settles); the coordinator must surface a streamed
 * kind-0 immediately — cold-boot headers must not wait out silent relays.
 * Misses during the boot window retry on the fast lane (seconds), not the
 * 30s-bucketed ladder.
 */
import type { Event } from 'nostr-tools';

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
const clientListeners = new Map<string, (event: Event) => void>();
jest.mock('./client.service', () => ({
  __esModule: true,
  default: {
    fetchProfileEvents: (pubkeys: string[]) => fetchProfileEvents(pubkeys),
    clearProfileEvent: jest.fn(),
    on: (name: string, listener: (event: Event) => void) => {
      clientListeners.set(name, listener);
    },
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

import coordinator, {
  PROFILE_BOOT_FAST_RETRY_MS,
  PROFILE_DISPATCH_MIN_SPACING_MS,
} from './profile-request-coordinator';

function kind0(pubkey: string, name: string, createdAt: number): Event {
  return {
    id: `id-${pubkey}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name, picture: null }),
    sig: '',
  } as Event;
}

const emitEarly = (event: Event): void => {
  clientListeners.get('replaceableEvent')?.(event);
};

beforeEach(() => {
  cacheMap.clear();
  fetchProfileEvents.mockReset();
  coordinator.resetForTesting();
});

describe('early-arrival kind-0 application', () => {
  it('surfaces a streamed profile immediately (cache + subscriber notify)', () => {
    const notifications: number[] = [];
    const unsubscribe = coordinator.subscribe(() => notifications.push(coordinator.getVersion()));

    emitEarly(kind0('pk_early', 'Early', 100));

    expect(coordinator.readKnown(['pk_early'])).toEqual({
      pk_early: expect.objectContaining({ name: 'Early' }),
    });
    expect(notifications.length).toBe(1);
    unsubscribe();
  });

  it('keeps the newest copy when relays stream versions out of order', () => {
    emitEarly(kind0('pk_versions', 'Newer', 200));
    emitEarly(kind0('pk_versions', 'Older', 100));

    expect(coordinator.readKnown(['pk_versions'])).toEqual({
      pk_versions: expect.objectContaining({ name: 'Newer' }),
    });
  });

  it('ignores streamed non-kind-0 events', () => {
    const versionBefore = coordinator.getVersion();
    emitEarly({ ...kind0('pk_list', 'x', 100), kind: 10002 } as Event);

    expect(coordinator.readKnown(['pk_list'])).toEqual({});
    expect(coordinator.getVersion()).toBe(versionBefore);
  });
});

describe('dispatch pacing', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('dispatches immediately when idle, then coalesces trickled demand into ONE batched REQ', async () => {
    jest.useFakeTimers();
    coordinator.beginBootWindowForTesting(0);
    coordinator.setDispatchMinSpacingForTesting(PROFILE_DISPATCH_MIN_SPACING_MS);
    fetchProfileEvents.mockImplementation(async (pubkeys) =>
      pubkeys.map((pubkey) => kind0(pubkey, pubkey, 1)),
    );

    // Idle coordinator: the first demand goes out without waiting.
    const releaseA = coordinator.retain(['pk_pace_a']);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    // Demand trickling in pubkey-by-pubkey within the spacing window must
    // NOT drip out as single-author dispatches.
    const releaseB = coordinator.retain(['pk_pace_b']);
    await jest.advanceTimersByTimeAsync(1_000);
    const releaseC = coordinator.retain(['pk_pace_c']);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    // At the spacing boundary, everything accumulated goes as one batch.
    await jest.advanceTimersByTimeAsync(PROFILE_DISPATCH_MIN_SPACING_MS);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(2);
    expect([...fetchProfileEvents.mock.calls[1][0]].sort()).toEqual(['pk_pace_b', 'pk_pace_c']);

    releaseA();
    releaseB();
    releaseC();
  });

  it('a cache-served flush does not delay the next network dispatch', async () => {
    jest.useFakeTimers();
    coordinator.beginBootWindowForTesting(0);
    coordinator.setDispatchMinSpacingForTesting(PROFILE_DISPATCH_MIN_SPACING_MS);
    fetchProfileEvents.mockImplementation(async (pubkeys) =>
      pubkeys.map((pubkey) => kind0(pubkey, pubkey, 1)),
    );

    // Already cached: retain flushes but no network dispatch happens.
    cacheMap.set('pk_cached', { name: 'Cached', picture: null });
    const releaseCached = coordinator.retain(['pk_cached']);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchProfileEvents).not.toHaveBeenCalled();

    // A real lookup right after must go out immediately — pacing counts
    // network dispatches, not flushes.
    const releaseFresh = coordinator.retain(['pk_fresh']);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    releaseCached();
    releaseFresh();
  });
});

describe('boot fast-retry lane', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries a boot-window miss after seconds, not the 30s ladder', async () => {
    jest.useFakeTimers();
    coordinator.beginBootWindowForTesting(0);
    coordinator.beginFastRetryWindowForTesting();
    fetchProfileEvents.mockResolvedValue([undefined]);

    const release = coordinator.retain(['pk_fast']);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    // Bucket quantization rounds the retry UP to the next shared 5s
    // boundary — due within two bucket widths of the miss.
    await jest.advanceTimersByTimeAsync(PROFILE_BOOT_FAST_RETRY_MS * 2 + 100);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(2);
    release();
  });

  it('quantizes fast retries into a shared bucket — staggered misses retry as ONE batch', async () => {
    jest.useFakeTimers();
    // Pin the clock phase so both misses (1.2s apart) round up to the SAME
    // 5s bucket — the property under test is that a shared bucket yields
    // one coalesced retry dispatch.
    jest.setSystemTime(1_000_000_003_000);
    coordinator.beginBootWindowForTesting(0);
    coordinator.beginFastRetryWindowForTesting();
    fetchProfileEvents.mockImplementation(async (pubkeys) => pubkeys.map(() => undefined));

    // Two misses ~1.2s apart (staggered batch resolutions).
    const releaseA = coordinator.retain(['pk_bucket_a']);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1_200);
    const releaseB = coordinator.retain(['pk_bucket_b']);
    await jest.advanceTimersByTimeAsync(0);
    const callsAfterMisses = fetchProfileEvents.mock.calls.length;

    // Walk through the retry window: both must come due in the SAME
    // coalesced dispatch, not one single-author REQ each.
    await jest.advanceTimersByTimeAsync(PROFILE_BOOT_FAST_RETRY_MS * 2 + 200);
    const retryCalls = fetchProfileEvents.mock.calls.slice(callsAfterMisses);
    const batchedRetry = retryCalls.find((call) => call[0].length === 2);
    expect(batchedRetry).toBeDefined();
    expect(retryCalls.some((call) => call[0].length === 1)).toBe(false);

    releaseA();
    releaseB();
  });

  it('misses outside the boot window follow the normal ladder (no fast retry)', async () => {
    jest.useFakeTimers();
    coordinator.beginBootWindowForTesting(0);
    // fastRetryUntil stays 0 (resetForTesting) — the window is closed.
    fetchProfileEvents.mockResolvedValue([undefined]);

    const release = coordinator.retain(['pk_slow']);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(PROFILE_BOOT_FAST_RETRY_MS + 100);
    expect(fetchProfileEvents).toHaveBeenCalledTimes(1);
    release();
  });
});
