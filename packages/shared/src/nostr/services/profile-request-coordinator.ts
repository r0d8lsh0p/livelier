import type { Event } from 'nostr-tools';
import type { ProfileInfo } from './profile.service';
import clientService from './client.service';
import profileCacheService from '../../services/ProfileCacheService';
import profileMissCache from './profile-miss-cache';
import { parseKind0Content } from '../utils/parse-kind0';
import {
  FailedProfileFetch,
  PROFILE_RETRY_MAX_ATTEMPTS,
  hasExhaustedProfileRetries,
  recordFailedProfileFetch,
} from '../../components/ui/chat/utils/profile-fetch-backoff';

/**
 * Minimal cache surface required by the partition/apply helpers below.
 * Matches the shared profileCacheService; tests inject fakes through it.
 */
export interface ProfileCacheLike {
  hasProfile(pubkey: string): boolean;
  getProfile(pubkey: string): ProfileInfo | null;
  storeProfile(pubkey: string, profile: ProfileInfo): void;
}

export interface PubkeyPartition {
  cachedProfiles: Record<string, ProfileInfo>;
  missingPubkeys: string[];
}

/**
 * Split pubkeys into cache hits and pubkeys that need a network fetch.
 *
 * The cache is checked FIRST — even for already-requested pubkeys — so a
 * profile that arrives in the cache later (fetched by another surface after
 * our fetch missed it) still resolves here instead of being permanently
 * skipped. `requested` is the shared in-flight set; `failures` is the shared
 * backoff ledger (both owned by the coordinator singleton).
 */
export function partitionPubkeys(
  pubkeys: string[],
  cache: ProfileCacheLike,
  requested: Set<string>,
  failures: Map<string, FailedProfileFetch>,
  now: number = Date.now(),
): PubkeyPartition {
  const cachedProfiles: Record<string, ProfileInfo> = {};
  const missingPubkeys: string[] = [];

  pubkeys.forEach((pubkey) => {
    if (cache.hasProfile(pubkey)) {
      const profile = cache.getProfile(pubkey);
      if (profile) {
        cachedProfiles[pubkey] = profile;
        return;
      }
    }

    // Skip if already requested (an in-flight fetch is settling it).
    if (requested.has(pubkey)) {
      return;
    }

    // Skip only while a previously-empty fetch is in its retry cooldown.
    // Misses DEFER, never terminate: relays deliver partial results (rate
    // limits, sharded aggregators, cold sockets), so an empty answer is not
    // proof of absence — once the cooldown (capped at 5 minutes) lapses the
    // pubkey re-coalesces with whatever dispatch goes out next.
    const failure = failures.get(pubkey);
    if (failure && now < failure.nextRetryAt) {
      return;
    }

    missingPubkeys.push(pubkey);
  });

  return { cachedProfiles, missingPubkeys };
}

/**
 * Apply a batch-fetch result: store found profiles in the cache and clear
 * their failure state; unmark pubkeys that came back empty (and record a
 * failure with exponential cooldown) so a later request can retry them.
 * Returns the non-null profiles for callers that want them.
 */
export function applyFetchedProfiles(
  fetchedProfiles: Record<string, ProfileInfo | null>,
  cache: ProfileCacheLike,
  requested: Set<string>,
  failures: Map<string, FailedProfileFetch>,
  now: number = Date.now(),
): Record<string, ProfileInfo> {
  const nonNullProfiles: Record<string, ProfileInfo> = {};

  Object.entries(fetchedProfiles).forEach(([pubkey, profile]) => {
    if (profile) {
      cache.storeProfile(pubkey, profile);
      failures.delete(pubkey);
      nonNullProfiles[pubkey] = profile;
    } else {
      requested.delete(pubkey);
      recordFailedProfileFetch(failures, pubkey, now);
    }
  });

  return nonNullProfiles;
}

/**
 * Release pubkeys whose batch fetch threw, so they can be retried after a
 * cooldown on the next request.
 */
export function releaseFailedPubkeys(
  pubkeys: string[],
  requested: Set<string>,
  failures: Map<string, FailedProfileFetch>,
  now: number = Date.now(),
): void {
  pubkeys.forEach((pubkey) => {
    requested.delete(pubkey);
    recordFailedProfileFetch(failures, pubkey, now);
  });
}

/**
 * Earliest future retry time among the given pubkeys' failures, or null when
 * nothing is awaiting retry. Only strictly-future cooldowns count: elapsed
 * ones are picked up by the next partition.
 */
export function earliestRetryAt(
  pubkeys: string[],
  failures: Map<string, FailedProfileFetch>,
  now: number = Date.now(),
): number | null {
  let earliest: number | null = null;
  pubkeys.forEach((pubkey) => {
    const failure = failures.get(pubkey);
    if (!failure || failure.nextRetryAt <= now) return;
    if (earliest === null || failure.nextRetryAt < earliest) {
      earliest = failure.nextRetryAt;
    }
  });
  return earliest;
}

function eventToProfile(event: Event | undefined): ProfileInfo | null {
  if (!event) return null;
  return parseKind0Content(event.content);
}

/**
 * ProfileRequestCoordinator
 *
 * The single owner of profile-loading coordination state for the whole app.
 * Before this existed, each `useProfilesForPubkeys` hook instance kept its own
 * in-flight set, backoff ledger, and retry timer in refs — so N mounted
 * surfaces (chat, cards, carousel host lockups) fetched the same pubkeys
 * independently, re-tried missing profiles on N uncoordinated timers, and
 * reset the retry budget on every remount. That fanned out into a flood of
 * concurrent relay REQs ("too many concurrent REQs").
 *
 * All of that state now lives here, once:
 *  - `wanted`   — ref-counted pubkeys some mounted surface currently displays.
 *  - `inFlight` — pubkeys with a batch fetch in progress (shared dedup).
 *  - `failures` — the one backoff ledger (capped-cadence retries, converges globally).
 *  - one `retryTimer` — a single heartbeat that retries still-wanted,
 *    non-exhausted pubkeys as one coalesced batch.
 *
 * Hooks become pure subscribers: `retain()` on mount, read via `subscribe` +
 * `getVersion` + `readKnown`. The successful-profile store remains the shared
 * `profileCacheService` singleton (the single source of truth for results).
 */
/**
 * How long after service creation (≈ app boot, module import time) profile
 * dispatches are held so serial boot demand coalesces. Boot surfaces mount
 * one after another — carousel host, nav avatar, creator rows — each more
 * than a batch window apart, which produced a drip of `authors x1` REQs
 * (measured: 51 of the 55 boot REQs). Holding dispatch for this window
 * turns the whole boot into ONE `authors xN` REQ. Sits inside the ~4s
 * splash budget.
 */
export const PROFILE_BOOT_AGGREGATION_MS = 2_000;

/**
 * Boot fast-retry lane: for the first minute of app life, a pubkey's first
 * two failed attempts retry after this delay instead of the 30s-bucketed
 * ladder. Cold-boot fetches routinely miss because relay sockets are still
 * handshaking — that must cost seconds, not half a minute of "Guest"
 * headers. Attempts stay counted, so the normal ladder and the exhaustion
 * cap resume from attempt three.
 */
export const PROFILE_BOOT_FAST_RETRY_MS = 5_000;
const PROFILE_BOOT_FAST_RETRY_WINDOW_MS = 60_000;
const PROFILE_BOOT_FAST_RETRY_MAX_ATTEMPTS = 2;

/**
 * Minimum spacing between network dispatches after the boot window. Demand
 * arrives pubkey-by-pubkey as content streams in (chat messages, rows,
 * cards each surfacing a host), and an unpaced flush-per-retain dripped
 * single-author REQs — measured: 9× "kinds=0 authors x1" in one boot
 * minute, the pattern relay rate limiters strike. While a dispatch is
 * pending, demand accumulates in `wanted` and goes out as ONE batched REQ.
 * An idle coordinator still dispatches immediately — only back-to-back
 * demand pays the spacing, so interactive lookups (profile screen opens
 * after a quiet period) stay instant.
 */
export const PROFILE_DISPATCH_MIN_SPACING_MS = 5_000;

class ProfileRequestCoordinator {
  private readonly cache: ProfileCacheLike = profileCacheService;
  private readonly wanted = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly failures = new Map<string, FailedProfileFetch>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** No dispatch before this instant — the boot aggregation window. */
  private bootWindowUntil = Date.now() + PROFILE_BOOT_AGGREGATION_MS;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  /** Failed first attempts retry on the fast lane until this instant. */
  private fastRetryUntil = Date.now() + PROFILE_BOOT_FAST_RETRY_WINDOW_MS;
  /** When the last network dispatch went out — drives dispatch pacing. */
  private lastDispatchAt = 0;
  private dispatchMinSpacingMs = PROFILE_DISPATCH_MIN_SPACING_MS;
  /** created_at of the newest kind-0 applied via the early-arrival path. */
  private readonly earlyProfileCreatedAt = new Map<string, number>();
  /** Resolves once both persisted caches (positive + negative) hydrated. */
  private readonly hydrated: Promise<void>;

  constructor() {
    // Bind the read-side API so consumers can pass the methods directly to
    // useSyncExternalStore without wrapping.
    this.subscribe = this.subscribe.bind(this);
    this.getVersion = this.getVersion.bind(this);

    // No relay dispatch happens before both persisted caches are loaded:
    // the positive cache (so warm boots serve from disk instead of
    // refetching profiles we already have — the cache is read synchronously,
    // and consulting it pre-hydration made every boot a cold boot), and the
    // negative cache (pubkeys that reached the slow lane in a previous
    // session start there instead of earning a fresh fast ladder per
    // reload — one immediate coalesced attempt, then the 5-minute cadence).
    // Miss entries expire after PROFILE_MISS_TTL_MS, a found profile clears
    // its entry, and refreshProfiles() bypasses on demand — never permanent.
    const cacheReady =
      typeof profileCacheService.whenInitialized === 'function'
        ? profileCacheService.whenInitialized()
        : Promise.resolve();
    const missesReady = profileMissCache.hydrate().then((missedPubkeys) => {
      missedPubkeys.forEach((pubkey) => {
        if (!this.failures.has(pubkey)) {
          this.failures.set(pubkey, {
            attempts: PROFILE_RETRY_MAX_ATTEMPTS,
            nextRetryAt: 0,
          });
        }
      });
    });
    this.hydrated = Promise.all([cacheReady, missesReady]).then(
      () => undefined,
      () => undefined,
    );

    // Early-arrival path: the client streams replaceable events per relay
    // delivery (before the batch's slowest relay settles). Applying kind-0s
    // here makes profiles visible at first-arrival latency — the batch
    // resolution later re-applies the newest copy, which this pre-empts,
    // not contradicts. Optional-chained: test doubles mock a partial client.
    const clientEmitter = clientService as unknown as {
      on?: (eventName: string, listener: (event: Event) => void) => void;
    };
    clientEmitter.on?.('replaceableEvent', (event: Event) => {
      this.applyEarlyProfileEvent(event);
    });
  }

  /** Apply a streamed kind-0 to the cache the moment a relay delivers it. */
  private applyEarlyProfileEvent(event: Event): void {
    if (event.kind !== 0) return;
    const newest = this.earlyProfileCreatedAt.get(event.pubkey);
    if (newest !== undefined && event.created_at <= newest) return;
    const profile = parseKind0Content(event.content);
    if (!profile) return;
    this.earlyProfileCreatedAt.set(event.pubkey, event.created_at);
    this.cache.storeProfile(event.pubkey, profile);
    this.failures.delete(event.pubkey);
    profileMissCache.clearMiss(event.pubkey);
    this.emit();
  }

  /** Subscribe to "profiles changed" notifications. Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Monotonic version, bumped whenever new profiles land. Stable snapshot. */
  getVersion(): number {
    return this.version;
  }

  /** Synchronous read of the currently-known profiles for these pubkeys. */
  readKnown(pubkeys: string[]): Record<string, ProfileInfo> {
    const result: Record<string, ProfileInfo> = {};
    pubkeys.forEach((pubkey) => {
      if (this.cache.hasProfile(pubkey)) {
        const profile = this.cache.getProfile(pubkey);
        if (profile) result[pubkey] = profile;
      }
    });
    return result;
  }

  /**
   * Declare display demand for a set of pubkeys (call on mount). Kicks a
   * batched fetch for any that are missing/fetchable and starts the shared
   * heartbeat. Returns a release fn to call on unmount.
   */
  retain(pubkeys: string[]): () => void {
    const unique = Array.from(new Set(pubkeys));
    unique.forEach((pubkey) => {
      this.wanted.set(pubkey, (this.wanted.get(pubkey) ?? 0) + 1);
    });

    void this.flush();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      unique.forEach((pubkey) => {
        const count = this.wanted.get(pubkey);
        if (count === undefined) return;
        if (count <= 1) this.wanted.delete(pubkey);
        else this.wanted.set(pubkey, count - 1);
      });
      this.scheduleRetry();
    };
  }

  /**
   * Imperative fetch for non-hook callers (profile screens, nav avatars,
   * product seller names). Retains the pubkeys so a real batched attempt runs
   * (deduped and shared with every other surface), waits until each is either
   * resolved or has had at least one attempt, then releases. Returns whatever
   * is known. `getProfile` is `getProfiles` of length one.
   *
   * A pubkey that misses here still lives in the shared backoff ledger, so if
   * any mounted hook displays it the single heartbeat self-heals it globally —
   * the caller does not need its own retry loop.
   */
  async getProfiles(
    pubkeys: string[],
    timeoutMs = 8000,
  ): Promise<Record<string, ProfileInfo | null>> {
    const release = this.retain(pubkeys);
    try {
      await this.waitUntilSettled(Array.from(new Set(pubkeys)), timeoutMs);
    } finally {
      release();
    }

    const result: Record<string, ProfileInfo | null> = {};
    pubkeys.forEach((pubkey) => {
      result[pubkey] = this.cache.hasProfile(pubkey)
        ? this.cache.getProfile(pubkey)
        : null;
    });
    return result;
  }

  /** True once a pubkey is resolved (cached) or has had at least one attempt. */
  private isSettled(pubkey: string): boolean {
    return this.cache.hasProfile(pubkey) || this.failures.has(pubkey);
  }

  /**
   * Resolve when every pubkey is settled (cached or attempted-and-missing), or
   * when `timeoutMs` elapses — whichever comes first.
   */
  private waitUntilSettled(pubkeys: string[], timeoutMs: number): Promise<void> {
    const allSettled = () => pubkeys.every((pk) => this.isSettled(pk));
    if (allSettled()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        resolve();
      };
      const unsubscribe = this.subscribe(() => {
        if (allSettled()) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  async getProfile(pubkey: string): Promise<ProfileInfo | null> {
    const result = await this.getProfiles([pubkey]);
    return result[pubkey] ?? null;
  }

  /**
   * Fetch every wanted pubkey that needs it, as one coalesced batch, then
   * (re)arm the single retry heartbeat. Safe to call repeatedly — the
   * partition + in-flight set make it idempotent.
   */
  private async flush(): Promise<void> {
    // Hold everything until the persisted caches are loaded — otherwise the
    // synchronous cache check below misses profiles that are on disk.
    await this.hydrated;

    // Dispatch pacing: the boot aggregation window first, then a minimum
    // spacing between network dispatches (PROFILE_DISPATCH_MIN_SPACING_MS).
    // While the timer is armed, demand accumulates instead of dispatching:
    // one timer fires ONE coalesced flush when the pacing allows.
    const earliestDispatchAt = Math.max(
      this.bootWindowUntil,
      this.lastDispatchAt + this.dispatchMinSpacingMs,
    );
    const untilDispatchAllowed = earliestDispatchAt - Date.now();
    if (untilDispatchAllowed > 0) {
      if (this.bootTimer === null) {
        this.bootTimer = setTimeout(() => {
          this.bootTimer = null;
          void this.flush();
        }, untilDispatchAllowed);
      }
      return;
    }

    const wantedKeys = Array.from(this.wanted.keys());
    if (wantedKeys.length === 0) {
      this.clearRetryTimer();
      return;
    }

    const { cachedProfiles, missingPubkeys } = partitionPubkeys(
      wantedKeys,
      this.cache,
      this.inFlight,
      this.failures,
    );

    // Cached hits may have landed via another surface — let subscribers read.
    if (Object.keys(cachedProfiles).length > 0) {
      this.emit();
    }

    if (missingPubkeys.length > 0) {
      // Pace from dispatch time, and only for real network dispatches —
      // cache-served flushes must not delay a later fetch.
      this.lastDispatchAt = Date.now();
      await this.dispatch(missingPubkeys);
    }

    this.scheduleRetry();
  }

  /** Run one batched relay fetch for a set of missing pubkeys. */
  private dispatch(pubkeys: string[]): Promise<void> {
    pubkeys.forEach((pubkey) => this.inFlight.add(pubkey));

    return clientService
      .fetchProfileEvents(pubkeys)
      .then((events) => {
        const fetched: Record<string, ProfileInfo | null> = {};
        pubkeys.forEach((pubkey, index) => {
          fetched[pubkey] = eventToProfile(events[index]);
        });

        applyFetchedProfiles(
          fetched,
          this.cache,
          this.inFlight,
          this.failures,
        );

        // Clear the in-flight mark for found profiles too (applyFetchedProfiles
        // only clears failures/requested for the empty ones).
        pubkeys.forEach((pubkey) => this.inFlight.delete(pubkey));

        this.applyBootFastRetryLane(pubkeys);
        this.persistLedgerTransitions(fetched);

        // Always notify: found profiles update readKnown; misses update the
        // backoff ledger, which imperative waiters (getProfiles) key off.
        this.emit();
      })
      .catch((error) => {
        console.warn('[ProfileRequestCoordinator] Batch profile fetch failed:', error);
        releaseFailedPubkeys(pubkeys, this.inFlight, this.failures);
        this.applyBootFastRetryLane(pubkeys);
        pubkeys.forEach((pubkey) => {
          if (hasExhaustedProfileRetries(this.failures.get(pubkey))) {
            profileMissCache.recordMiss(pubkey);
          }
        });
        this.emit();
      });
  }

  /**
   * During the boot window, pull a fresh failure's next retry forward to
   * the fast lane (see PROFILE_BOOT_FAST_RETRY_MS). Only the first attempts
   * qualify; later ones follow the normal exponential ladder.
   */
  private applyBootFastRetryLane(pubkeys: string[]): void {
    const now = Date.now();
    if (now >= this.fastRetryUntil) return;
    // Quantized UP to a shared bucket, same as the main ladder's 30s
    // buckets: pubkeys whose batches resolved at slightly different moments
    // must come due together and retry as ONE coalesced REQ. An unquantized
    // now+5s desynchronized into a drip of single-author REQs — exactly
    // what relay rate limiters strike.
    const fastRetryAt =
      Math.ceil((now + PROFILE_BOOT_FAST_RETRY_MS) / PROFILE_BOOT_FAST_RETRY_MS) *
      PROFILE_BOOT_FAST_RETRY_MS;
    pubkeys.forEach((pubkey) => {
      const failure = this.failures.get(pubkey);
      if (!failure || hasExhaustedProfileRetries(failure)) return;
      if (failure.attempts > PROFILE_BOOT_FAST_RETRY_MAX_ATTEMPTS) return;
      failure.nextRetryAt = Math.min(failure.nextRetryAt, fastRetryAt);
    });
  }

  /**
   * Mirror this batch's ledger transitions into the persistent negative
   * cache: found profiles clear their entry; misses that just reached the
   * slow-lane threshold are recorded so the next session starts at the
   * capped cadence instead of a fresh fast ladder. Retries never stop.
   */
  private persistLedgerTransitions(fetched: Record<string, ProfileInfo | null>): void {
    Object.entries(fetched).forEach(([pubkey, profile]) => {
      if (profile) {
        profileMissCache.clearMiss(pubkey);
      } else if (hasExhaustedProfileRetries(this.failures.get(pubkey))) {
        profileMissCache.recordMiss(pubkey);
      }
    });
  }

  /**
   * Force refresh: bypass the positive cache, the retry ledger, and the
   * persistent negative cache, and refetch from relays. The escape hatch for
   * profiles that wrongly settled as missing or stale. If the refetch comes
   * back empty, any previously cached profile is restored rather than lost.
   */
  async refreshProfiles(pubkeys: string[]): Promise<Record<string, ProfileInfo | null>> {
    const unique = Array.from(new Set(pubkeys));
    const previous = new Map<string, ProfileInfo>();

    unique.forEach((pubkey) => {
      const cached = this.cache.hasProfile(pubkey) ? this.cache.getProfile(pubkey) : null;
      if (cached) previous.set(pubkey, cached);
      profileCacheService.removeProfile(pubkey);
      this.failures.delete(pubkey);
      profileMissCache.clearMiss(pubkey);
      clientService.clearProfileEvent(pubkey);
    });

    const result = await this.getProfiles(unique);

    unique.forEach((pubkey) => {
      if (!result[pubkey]) {
        const restored = previous.get(pubkey);
        if (restored) {
          this.cache.storeProfile(pubkey, restored);
          result[pubkey] = restored;
        }
      }
    });

    this.emit();
    return result;
  }

  /** (Re)arm the single heartbeat at the earliest future cooldown of a wanted pubkey. */
  private scheduleRetry(): void {
    const wantedKeys = Array.from(this.wanted.keys());
    const retryAt = earliestRetryAt(wantedKeys, this.failures);
    this.clearRetryTimer();
    if (retryAt === null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, Math.max(0, retryAt - Date.now()));
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private emit(): void {
    this.version += 1;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('[ProfileRequestCoordinator] listener error:', error);
      }
    });
  }

  /** Test helper: reset all shared state between tests. */
  resetForTesting(): void {
    this.wanted.clear();
    this.inFlight.clear();
    this.failures.clear();
    this.listeners.clear();
    this.earlyProfileCreatedAt.clear();
    this.version = 0;
    this.clearRetryTimer();
    this.bootWindowUntil = 0;
    this.fastRetryUntil = 0;
    this.lastDispatchAt = 0;
    this.dispatchMinSpacingMs = 0;
    if (this.bootTimer !== null) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
  }

  /** Test helper: open a fresh boot aggregation window from "now". */
  beginBootWindowForTesting(durationMs: number = PROFILE_BOOT_AGGREGATION_MS): void {
    this.bootWindowUntil = Date.now() + durationMs;
  }

  /** Test helper: open a fresh boot fast-retry window from "now". */
  beginFastRetryWindowForTesting(durationMs: number = 60_000): void {
    this.fastRetryUntil = Date.now() + durationMs;
  }

  /** Test helper: set the dispatch pacing (resetForTesting zeroes it). */
  setDispatchMinSpacingForTesting(ms: number): void {
    this.dispatchMinSpacingMs = ms;
  }
}

const profileRequestCoordinator = new ProfileRequestCoordinator();
export default profileRequestCoordinator;
