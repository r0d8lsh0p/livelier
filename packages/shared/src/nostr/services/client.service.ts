import { SimplePool, Filter, kinds, Event, EventTemplate } from 'nostr-tools';
import { cachedVerifyEvent, markEventVerified } from './event-verifier';
import { RelayList } from '../relay-utils';
import relayService from './relay.service';
import { ISigner } from '../types';
import { withTimeout } from '../../utils/promise-timeout';
import { logRelayError, logRelayNotice, logRelayClosed, logRelayCooldown, logRelayReq, logNetworkError } from '../../dev/structured-log';
import { recordReqOpened, recordReqClosed } from '../../dev/relay-req-stats';
import {
  FailedProfileFetch,
  recordFailedProfileFetch,
} from '../../components/ui/chat/utils/profile-fetch-backoff';

// Timeouts in milliseconds
/**
 * Per-relay silence deadline for one-shot queries. A relay that has neither
 * EOSEd nor CLOSEd by now gets its REQ closed — an open one-shot REQ occupies
 * a subscription slot on the relay (nostream counts concurrent REQs per
 * connection), so stalled fetches must not linger for the full query timeout.
 */
export const QUERY_EOSE_DEADLINE = 10000; // 10 seconds
/**
 * Per-tier deadline for replaceable-event loader queries. The loader asks
 * the profile relays first and the remaining read relays only on a miss —
 * two serial tiers. Callers budget 8-10s for a list fetch (mute list,
 * follow list), so each tier must settle well inside half of that: one
 * slow relay in tier 1 must not eat the whole caller budget before tier 2
 * gets its turn. EOSE normally arrives in <2s; 4s is generous.
 */
export const REPLACEABLE_QUERY_DEADLINE = 4000;
const SIGNER_OPERATION_TIMEOUT_MS = 60000;

/**
 * Rate-limit cooldown ladder. A relay that CLOSEs a REQ with a rate-limit
 * reason has an empty per-IP token bucket — every further REQ (including
 * nostr-tools' automatic resubscribe-on-reconnect) is refused and just
 * feeds the death spiral that starves interactive REQs like chat history.
 * First strike cools the relay for the base duration; repeat episodes
 * (rate-limited again after a cooldown expired) double it, capped.
 */
export const RELAY_COOLDOWN_BASE_MS = 60_000;
export const RELAY_COOLDOWN_MAX_MS = 10 * 60_000;

/**
 * Simple EventEmitter implementation for cross-platform compatibility
 */
class EventEmitter {
  private listeners: Record<string, Array<(data: any) => void>> = {};
  
  /**
   * Add an event listener
   */
  on(event: string, listener: (data: any) => void): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(listener);
  }
  
  /**
   * Remove an event listener
   */
  off(event: string, listener: (data: any) => void): void {
    if (!this.listeners[event]) return;
    
    const index = this.listeners[event].indexOf(listener);
    if (index !== -1) {
      this.listeners[event].splice(index, 1);
    }
  }
  
  /**
   * Emit an event
   */
  emit(event: string, data?: any): void {
    if (!this.listeners[event]) return;
    
    this.listeners[event].forEach(listener => {
      try {
        listener(data);
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error);
      }
    });
  }
}

/**
 * Helper function to log with timestamp
 */
function logWithTime(message: string, ...args: any[]): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, ...args);
}

/**
 * Simple LRU Cache implementation
 */
class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;
  private keyUsage: Map<K, number>; // Track last access time
  
  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map<K, V>();
    this.keyUsage = new Map<K, number>();
  }
  
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    
    // Update usage timestamp
    this.keyUsage.set(key, Date.now());
    return this.cache.get(key);
  }
  
  set(key: K, value: V): void {
    // If at capacity and adding new key, evict least recently used
    if (this.cache.size >= this.capacity && !this.cache.has(key)) {
      this.evictLRU();
    }
    
    // Add/update the item
    this.cache.set(key, value);
    this.keyUsage.set(key, Date.now());
  }
  
  delete(key: K): boolean {
    this.keyUsage.delete(key);
    return this.cache.delete(key);
  }
  
  has(key: K): boolean {
    return this.cache.has(key);
  }
  
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }
  
  get size(): number {
    return this.cache.size;
  }
  
  clear(): void {
    this.cache.clear();
    this.keyUsage.clear();
  }
  
  private evictLRU(): void {
    if (this.cache.size === 0) return;
    
    let lruKey: K | null = null;
    let lruTime = Infinity;
    
    // Find the least recently used key
    for (const [key, time] of this.keyUsage.entries()) {
      if (time < lruTime) {
        lruKey = key;
        lruTime = time;
      }
    }
    
    // Remove the LRU item
    if (lruKey !== null) {
      this.cache.delete(lruKey);
      this.keyUsage.delete(lruKey);
    }
  }
}

/**
 * Simple batch loader implementation
 */
export class BatchLoader<K, V> {
  private batchLoadFn: (keys: readonly K[]) => Promise<(V | undefined)[]>;
  private cache: LRUCache<K, V>;
  private batchSize: number;
  private batchDelay: number;
  /**
   * The one batch currently accepting joins. Loads join it until it
   * dispatches (batchDelay after its first load) or fills to batchSize —
   * NOT until a wall-clock bucket rolls over. Keying batches by
   * Math.floor(now / delay) meant loads arriving more than batchDelay apart
   * (e.g. list rows resolving one per render frame) each fired their own
   * single-key relay REQ; a burst of N produced N REQs to every read relay.
   */
  private pendingBatch: { keys: K[]; promise: Promise<(V | undefined)[]> } | null = null;
  /** Per-key in-flight dedup: concurrent loads of one key share one fetch. */
  private inFlight = new Map<K, Promise<V | undefined>>();

  constructor(
    batchLoadFn: (keys: readonly K[]) => Promise<(V | undefined)[]>,
    options: {
      cache?: LRUCache<K, V>;
      batchSize?: number;
      batchDelay?: number;
    } = {}
  ) {
    this.batchLoadFn = batchLoadFn;
    this.cache = options.cache || new LRUCache<K, V>(1000);
    this.batchSize = options.batchSize || 100;
    this.batchDelay = options.batchDelay || 50;
  }

  async load(key: K): Promise<V | undefined> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.joinBatch(key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private joinBatch(key: K): Promise<V | undefined> {
    if (!this.pendingBatch || this.pendingBatch.keys.length >= this.batchSize) {
      const keys: K[] = [];
      const batch = {
        keys,
        promise: new Promise<(V | undefined)[]>((resolve) => {
          setTimeout(async () => {
            // Stop accepting joins before dispatching, so late loads start
            // a fresh batch instead of missing this fetch.
            if (this.pendingBatch === batch) {
              this.pendingBatch = null;
            }
            try {
              const values = await this.batchLoadFn(keys);

              keys.forEach((k, i) => {
                if (values[i] !== undefined) {
                  this.cache.set(k, values[i] as V);
                }
              });

              resolve(values);
            } catch (error) {
              console.error('BatchLoader: Error loading batch:', error);
              resolve(new Array(keys.length).fill(undefined));
            }
          }, this.batchDelay);
        }),
      };
      this.pendingBatch = batch;
    }

    const batch = this.pendingBatch;
    batch.keys.push(key);
    const keyIndex = batch.keys.length - 1;
    return batch.promise.then((values) => values[keyIndex]);
  }

  async loadMany(keys: K[]): Promise<(V | undefined)[]> {
    return Promise.all(keys.map(key => this.load(key)));
  }

  clear(key: K): void {
    this.cache.delete(key);
  }

  prime(key: K, value: V): void {
    this.cache.set(key, value);
  }
}

/** Addressable events (NIP-01): replaceable per (pubkey, kind, d tag). */
function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** A single replaceable/addressable event lookup. `d` is required for addressable kinds. */
export type ReplaceableEventRequest = { pubkey: string; kind: number; d?: string };

/**
 * Kinds safe to serve from the replaceable-event loader's session cache.
 * Deliberately excludes dynamic addressable kinds — above all 30311 live
 * events, whose status/participants must never be served stale.
 */
const CACHEABLE_REPLACEABLE_KINDS = new Set<number>([
  kinds.Metadata, // 0
  kinds.Contacts, // 3
  kinds.Mutelist, // 10000
  kinds.RelayList, // 10002
  kinds.UserEmojiList, // 10030
  kinds.Emojisets, // 30030
  39089, // NIP-51 follow packs — the curated featured-creator lists
]);

/**
 * Batching loader for replaceable and addressable events, keyed
 * `{pubkey, kind, d}` — Jumble's replaceableEventDataLoader pattern.
 *
 * Every profile / contacts / mute-list / relay-list / emoji-list / emoji-set /
 * featured-list lookup joins ONE batch window and dispatches as ONE
 * multi-filter REQ (one filter per kind, authors and d tags merged), instead
 * of each fetch type firing its own REQ to every read relay. The separate
 * per-kind REQ pattern is what tripped relay rate limiters ("rate-limited:
 * there is a bug in the client") and starved fetches like custom emojis.
 *
 * Misses are negative-cached with the shared exponential backoff ledger
 * (30s → 5m, bounded attempts), so a pubkey with no such event stops being
 * re-queried — EXCEPT kind 0, whose retry policy is owned by the
 * profile-request-coordinator; double-ledgering profiles would desync its
 * heartbeat.
 */
type QueryResult = { events: Event[]; eoseCount: number };

/**
 * Per-query streaming hooks. `onEvent` fires for each event as a relay
 * delivers it — BEFORE the batch promise resolves — so consumers (the
 * profile coordinator) can surface results at first-arrival latency instead
 * of slowest-relay latency. `isComplete` is checked after every event;
 * once it returns true the query closes every relay REQ and resolves —
 * a fully-answered batch must not wait out a cold socket's deadline.
 */
export type ReplaceableQueryHooks = {
  onEvent?: (event: Event) => void;
  isComplete?: (events: Event[]) => boolean;
};

export class ReplaceableEventLoader {
  private loader: BatchLoader<string, Event>;
  private missLedger = new Map<string, FailedProfileFetch>();
  private queryFn: (filters: Filter[], hooks?: ReplaceableQueryHooks) => Promise<QueryResult>;
  /**
   * Optional second-tier query for keys the primary miss. Lets the primary
   * target a small dedicated relay set (see AppConfig.profileRelays) while
   * still asking the wider read set before a key resolves as missing — a
   * profile that lives only on a user-configured relay must never be
   * negative-cached because the dedicated set didn't carry it.
   */
  private fallbackQueryFn?: (filters: Filter[], hooks?: ReplaceableQueryHooks) => Promise<QueryResult>;
  /** Streams every event to the owner as relays deliver it (pre-resolution). */
  private onEvent?: (event: Event) => void;

  constructor(
    queryFn: (filters: Filter[], hooks?: ReplaceableQueryHooks) => Promise<QueryResult>,
    options: {
      batchDelay?: number;
      batchSize?: number;
      fallbackQueryFn?: (filters: Filter[], hooks?: ReplaceableQueryHooks) => Promise<QueryResult>;
      onEvent?: (event: Event) => void;
    } = {}
  ) {
    this.queryFn = queryFn;
    this.fallbackQueryFn = options.fallbackQueryFn;
    this.onEvent = options.onEvent;
    this.loader = new BatchLoader<string, Event>(
      (keys) => this.batchLoad(keys),
      {
        batchDelay: options.batchDelay ?? 200,
        batchSize: options.batchSize ?? 500,
      }
    );
  }

  /**
   * Completion predicate for a query tier: true once every requested key
   * resolves against the events received so far, letting the tier close its
   * relay REQs instead of waiting out slow/silent relays. Trade-off: a
   * slower relay carrying a NEWER version of an already-resolved key is
   * skipped — acceptable for profile/list lookups where versions churn
   * rarely and boot latency dominates.
   */
  private static makeCompletionPredicate(
    keys: string[],
    requests: ReplaceableEventRequest[]
  ): (events: Event[]) => boolean {
    return (events) => {
      const maps = ReplaceableEventLoader.buildNewestMaps(events);
      return requests.every(
        (request, i) =>
          ReplaceableEventLoader.resolveRequest(keys[i], request, maps) !== undefined
      );
    };
  }

  private static toKey({ pubkey, kind, d }: ReplaceableEventRequest): string {
    return `${kind}:${pubkey}:${d ?? ''}`;
  }

  private static parseKey(key: string): ReplaceableEventRequest {
    // d tags may themselves contain ':' — only the first two segments are ours
    const [kindStr, pubkey, ...dParts] = key.split(':');
    const d = dParts.join(':');
    return { pubkey, kind: Number(kindStr), d: d || undefined };
  }

  async load(request: ReplaceableEventRequest): Promise<Event | undefined> {
    const key = ReplaceableEventLoader.toKey(request);

    // Miss cooldown only — deliberately NOT session-permanent (no
    // hasExhaustedProfileRetries): a false miss (relay throttling, boot
    // race) must always heal eventually. The ladder caps at 5 minutes.
    const miss = this.missLedger.get(key);
    if (miss && Date.now() < miss.nextRetryAt) {
      return undefined;
    }

    return this.loader.load(key);
  }

  async loadMany(requests: ReplaceableEventRequest[]): Promise<(Event | undefined)[]> {
    return Promise.all(requests.map((request) => this.load(request)));
  }

  /** Drop a cached event and its miss record so the next load refetches. */
  clear(request: ReplaceableEventRequest): void {
    const key = ReplaceableEventLoader.toKey(request);
    this.loader.clear(key);
    this.missLedger.delete(key);
  }

  /**
   * Install an event as the cached newest version of its coordinate and
   * forget any recorded miss — call with a just-published or
   * subscription-observed replaceable event (write-through, à la Jumble's
   * updateReplaceableEventCache).
   */
  prime(event: Event): void {
    const d = isAddressableKind(event.kind)
      ? event.tags.find((tag) => tag[0] === 'd')?.[1]
      : undefined;
    const key = ReplaceableEventLoader.toKey({ pubkey: event.pubkey, kind: event.kind, d });
    this.loader.prime(key, event);
    this.missLedger.delete(key);
  }

  /**
   * One filter per kind; authors merged, d tags merged for addressable
   * kinds. The `limit` is deliberately GENEROUS (3× the request count),
   * not exact: NIP-01 limit means "newest N events globally", not "one
   * per author" — relays that retain multiple versions of active authors'
   * replaceables can spend an exact-count budget on duplicates and squeeze
   * out authors whose event is old. Omitting the limit entirely (Jumble's
   * shape) is not safe either: at least one major relay empty-answers
   * large no-limit author queries (measured on damus: 0/78 authors
   * without a limit, 46/78 with one, fresh sockets back to back).
   */
  private static buildBatchFilters(requests: ReplaceableEventRequest[]): Filter[] {
    const groups = new Map<number, { authors: Set<string>; ds: Set<string> }>();
    requests.forEach(({ pubkey, kind, d }) => {
      let group = groups.get(kind);
      if (!group) {
        group = { authors: new Set(), ds: new Set() };
        groups.set(kind, group);
      }
      group.authors.add(pubkey);
      if (isAddressableKind(kind) && d) {
        group.ds.add(d);
      }
    });

    return Array.from(groups.entries()).map(([kind, group]) => {
      const filter: Filter = {
        kinds: [kind],
        authors: Array.from(group.authors),
        limit: group.authors.size * Math.max(1, group.ds.size) * 3,
      };
      if (group.ds.size > 0) {
        filter['#d'] = Array.from(group.ds);
      }
      return filter;
    });
  }

  /**
   * Newest event per coordinate; also per (kind, pubkey) for addressable
   * requests that did not specify a d tag.
   */
  private static buildNewestMaps(events: Event[]): {
    newestByCoordinate: Map<string, Event>;
    newestByKindPubkey: Map<string, Event>;
  } {
    const newestByCoordinate = new Map<string, Event>();
    const newestByKindPubkey = new Map<string, Event>();
    events.forEach((event) => {
      const d = isAddressableKind(event.kind)
        ? (event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '')
        : '';
      const coordinate = `${event.kind}:${event.pubkey}:${d}`;
      const existing = newestByCoordinate.get(coordinate);
      if (!existing || existing.created_at < event.created_at) {
        newestByCoordinate.set(coordinate, event);
      }
      const kindPubkey = `${event.kind}:${event.pubkey}`;
      const existingLoose = newestByKindPubkey.get(kindPubkey);
      if (!existingLoose || existingLoose.created_at < event.created_at) {
        newestByKindPubkey.set(kindPubkey, event);
      }
    });
    return { newestByCoordinate, newestByKindPubkey };
  }

  private static resolveRequest(
    key: string,
    request: ReplaceableEventRequest,
    maps: { newestByCoordinate: Map<string, Event>; newestByKindPubkey: Map<string, Event> }
  ): Event | undefined {
    const exact = maps.newestByCoordinate.get(key);
    const { pubkey, kind, d } = request;
    return (
      exact ??
      (isAddressableKind(kind) && !d
        ? maps.newestByKindPubkey.get(`${kind}:${pubkey}`)
        : undefined)
    );
  }

  /**
   * Negative-cache genuine misses only: at least one relay must have EOSEd
   * for "no event" to mean anything. eoseCount 0 (boot race, all relays
   * refusing) stays unrecorded so the next load retries. Kind 0 is exempt —
   * the profile-request-coordinator owns profile retries.
   */
  private recordOutcome(key: string, kind: number, resolved: Event | undefined, eoseCount: number): void {
    if (kind === kinds.Metadata) return;
    if (resolved !== undefined) {
      this.missLedger.delete(key);
    } else if (eoseCount > 0) {
      recordFailedProfileFetch(this.missLedger, key);
    }
  }

  private async batchLoad(keys: readonly string[]): Promise<(Event | undefined)[]> {
    const requests = keys.map((key) => ReplaceableEventLoader.parseKey(key));
    const results: (Event | undefined)[] = new Array(keys.length).fill(undefined);

    const allIndexes = requests.map((_, i) => i);
    logWithTime(
      `ClientService: Batch loading ${requests.length} replaceable events`
    );
    await this.loadViaBigRelays(keys, requests, allIndexes, results);

    return results;
  }

  private async loadViaBigRelays(
    keys: readonly string[],
    requests: ReplaceableEventRequest[],
    indexes: number[],
    results: (Event | undefined)[]
  ): Promise<void> {
    if (indexes.length === 0) return;
    const subRequests = indexes.map((i) => requests[i]);
    const subKeys = indexes.map((i) => keys[i]);

    try {
      const primary = await this.queryFn(ReplaceableEventLoader.buildBatchFilters(subRequests), {
        onEvent: this.onEvent,
        isComplete: ReplaceableEventLoader.makeCompletionPredicate(subKeys, subRequests),
      });
      let allEvents = primary.events;
      let eoseTotal = primary.eoseCount;

      // Second-tier ask: keys the primary relays missed go to the fallback
      // set (the remaining read relays) before resolving as missing. Only
      // the unresolved subset is re-queried.
      if (this.fallbackQueryFn) {
        const primaryMaps = ReplaceableEventLoader.buildNewestMaps(primary.events);
        const unresolvedIndexes = indexes.filter(
          (i) =>
            ReplaceableEventLoader.resolveRequest(keys[i], requests[i], primaryMaps) === undefined
        );
        if (unresolvedIndexes.length > 0) {
          const unresolvedRequests = unresolvedIndexes.map((i) => requests[i]);
          const unresolvedKeys = unresolvedIndexes.map((i) => keys[i]);
          const fallback = await this.fallbackQueryFn(
            ReplaceableEventLoader.buildBatchFilters(unresolvedRequests),
            {
              onEvent: this.onEvent,
              isComplete: ReplaceableEventLoader.makeCompletionPredicate(
                unresolvedKeys,
                unresolvedRequests
              ),
            }
          );
          allEvents = allEvents.concat(fallback.events);
          eoseTotal += fallback.eoseCount;
        }
      }

      const maps = ReplaceableEventLoader.buildNewestMaps(allEvents);
      indexes.forEach((i) => {
        const resolved = ReplaceableEventLoader.resolveRequest(keys[i], requests[i], maps);
        results[i] = resolved;
        this.recordOutcome(keys[i], requests[i].kind, resolved, eoseTotal);
      });
    } catch (error) {
      logNetworkError('batchLoadReplaceableEvents', error);
    }
  }

}

/**
 * ClientService - Core service for Nostr operations with caching
 *
 * This service is modeled after Jumble's ClientService and provides:
 * - A SimplePool instance for Nostr operations
 * - LRU caching for events
 * - Batch loading for efficient fetching
 * - Event tracking and deduplication
 */
class ClientService extends EventEmitter {
  static instance: ClientService;
  
  private pool: SimplePool;
  
  // Event cache and data loaders
  private eventCache = new LRUCache<string, Event>(10000);
  
  // Client tag configuration
  private clientName: string | null = null;

  // Signed event deduplication - prevent signature storms
  private signedEventCache = new Map<string, Event>();
  private inflightRequests = new Map<string, Promise<Event>>();
  private eventDataLoader = new BatchLoader<string, Event>(
    // By-id network fetching was removed with the app surface; the loader
    // survives purely as the primed event cache behind subscribe/query.
    async (ids) => ids.map(() => undefined),
    {
      cache: this.eventCache,
      batchDelay: 500,
      batchSize: 100
    }
  );
  /**
   * All replaceable/addressable lookups (profiles, contacts, mute lists,
   * relay lists, emoji lists/sets, featured lists) coalesce here into one
   * multi-filter REQ per batch window. Primary queries go to the small
   * dedicated profile relay set; only keys those miss are re-asked on the
   * remaining read relays — keeping the steady drip of small batch REQs off
   * the general read relays whose rate limiters were closing us. See
   * ReplaceableEventLoader.
   */
  private replaceableEventLoader = new ReplaceableEventLoader(
    (filters, hooks) =>
      this.queryWithStats(relayService.getProfileRelays(), filters, hooks?.onEvent, {
        eoseDeadlineMs: REPLACEABLE_QUERY_DEADLINE,
        isComplete: hooks?.isComplete,
      }),
    {
      fallbackQueryFn: (filters, hooks) =>
        this.queryWithStats(relayService.getProfileFallbackRelays(), filters, hooks?.onEvent, {
          eoseDeadlineMs: REPLACEABLE_QUERY_DEADLINE,
          isComplete: hooks?.isComplete,
        }),
      // Stream every replaceable event to subscribers at arrival time (the
      // profile coordinator applies kind-0s to the cache immediately) —
      // consumers must not wait for the batch's slowest relay.
      onEvent: (event) => this.emit('replaceableEvent', event),
    }
  );
  
  private connectionMonitorInterval?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    logWithTime('ClientService: Initializing (trackRelays=true, reconnect=true, ping=true)');
    this.pool = new SimplePool({ enableReconnect: true, enablePing: true });
    // Full Schnorr only on first sight of an event ID — see event-verifier.ts.
    // Relays read this lazily in ensureRelay, so assigning here covers every
    // connection the pool will ever open.
    this.pool.verifyEvent = cachedVerifyEvent;
    this.pool.trackRelays = true;
    this.startConnectionMonitor();
  }
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): ClientService {
    if (!ClientService.instance) {
      ClientService.instance = new ClientService();
    }
    return ClientService.instance;
  }

  setClientName(name: string): void {
    this.clientName = name;
  }

  /**
   * Compact one-line summary of a REQ's filters for [RELAY_CLOSED] logs, so a
   * relay-refused subscription can be traced back to the query that sent it.
   */
  private static summarizeFilters(filters: Filter[]): string {
    return filters
      .map((f) => {
        const parts: string[] = [];
        if (f.kinds?.length) parts.push(`kinds=${f.kinds.join(',')}`);
        if (f.ids?.length) parts.push(`ids x${f.ids.length}`);
        if (f.authors?.length) parts.push(`authors x${f.authors.length}`);
        if (f['#a']?.length) parts.push(`#a x${f['#a'].length}`);
        if (f['#e']?.length) parts.push(`#e x${f['#e'].length}`);
        if (f['#p']?.length) parts.push(`#p x${f['#p'].length}`);
        if (f['#d']?.length) parts.push(`#d x${f['#d'].length}`);
        return parts.join(' ') || 'no-constraint';
      })
      .join(' | ');
  }

  /** Relay connections whose NOTICE hook has been attached (one per socket). */
  private noticeInstrumented = new WeakSet<object>();

  /** Relays in rate-limit cooldown: strikes escalate across episodes. */
  private relayCooldowns = new Map<string, { strikes: number; until: number }>();


  private static isRateLimitReason(reason: string): boolean {
    return reason.toLowerCase().includes('rate-limit');
  }

  /** True while a relay's rate-limit cooldown is active. */
  isRelayCoolingDown(url: string): boolean {
    const cooldown = this.relayCooldowns.get(url);
    return cooldown !== undefined && Date.now() < cooldown.until;
  }

  /**
   * Start (or escalate) a relay's rate-limit cooldown and sever its socket.
   * A caller-initiated close does NOT auto-reconnect, which stops
   * nostr-tools from re-sending every open sub's REQ to a relay that is
   * refusing us — the spiral that keeps the token bucket empty.
   *
   * An active cooldown is never extended by further rate-limit closes:
   * attempts during the cooldown (e.g. a user opening chat) must not push
   * recovery further away. Strikes escalate only across separate episodes.
   */
  private markRelayRateLimited(url: string): void {
    const now = Date.now();
    const prev = this.relayCooldowns.get(url);
    if (prev && now < prev.until) return;

    const strikes = (prev?.strikes ?? 0) + 1;
    const duration = Math.min(RELAY_COOLDOWN_BASE_MS * 2 ** (strikes - 1), RELAY_COOLDOWN_MAX_MS);
    this.relayCooldowns.set(url, { strikes, until: now + duration });
    logRelayCooldown(url, `rate-limited — cooling down ${Math.round(duration / 1000)}s (strike ${strikes})`);

    try {
      this.pool.close([url]);
    } catch {
      // The socket may already be gone — cooldown state is what matters.
    }
  }

  /**
   * A real answer (EOSE) after a cooldown expired means the relay is
   * serving us again — forget its strike history so a future episode
   * starts back at the base cooldown.
   */
  private noteRelayAnswered(url: string): void {
    const cooldown = this.relayCooldowns.get(url);
    if (cooldown && Date.now() >= cooldown.until) {
      this.relayCooldowns.delete(url);
      logRelayCooldown(url, 'answered after cooldown — strikes cleared');
    }
  }

  /**
   * Background one-shots skip relays in cooldown: asking a rate-limiting
   * relay again is a guaranteed refusal that delays its recovery. (Live
   * subscriptions via subscribe() are NOT gated — a user-facing surface may
   * try once; it just must not loop.)
   */
  private filterCoolingRelays(urls: string[]): string[] {
    return urls.filter((url) => !this.isRelayCoolingDown(url));
  }

  /**
   * Attach a NOTICE logger to a relay connection. Relays announce rejection
   * reasons — rate limits, "too many concurrent REQs", auth demands — via
   * NOTICE frames, which nostr-tools routes to console.debug by default,
   * leaving relay-side throttling invisible. Safe to call repeatedly; hooks
   * once per underlying socket.
   */
  private instrumentRelay<T extends { url: string; onnotice: (msg: string) => void }>(relay: T): T {
    if (!this.noticeInstrumented.has(relay)) {
      this.noticeInstrumented.add(relay);
      relay.onnotice = (msg: string) => logRelayNotice(relay.url, msg);
    }
    return relay;
  }

  /**
   * Open a standing subscription on every given relay.
   *
   * Rate-limit resilience: a relay that CLOSEs a standing REQ with a
   * rate-limit reason is severed (stopping the REQ spiral) and put in
   * cooldown — and this method re-opens the subscription on that relay
   * once the cooldown lapses, so a long-lived consumer (the chat
   * firehose) survives transient rate limiting instead of silently losing
   * a relay for the rest of the process.
   */
  subscribe(
    urls: string[],
    filter: Filter | Filter[],
    {
      onevent,
      oneose,
      onclose
    }: {
      onevent?: (evt: Event) => void;
      oneose?: (eosed: boolean) => void;
      onclose?: (reasons: string[]) => void;
    }
  ) {
    const relays = Array.from(new Set(urls));
    const filters = Array.isArray(filter) ? filter : [filter];
    const filterSummary = ClientService.summarizeFilters(filters);

    // Track known event IDs to avoid duplicates across relays
    const _knownIds = new Set<string>();
    const startedCount = relays.length;
    let eosedCount = 0;
    let eosed = false;
    let closedCount = 0;
    const closeReasons: string[] = [];
    let callerClosed = false;
    const activeSubs = new Map<string, { close: () => void }>();
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();

    const noteEose = (): void => {
      if (eosed) return;
      eosedCount++;
      eosed = eosedCount >= startedCount;
      if (eosed) oneose?.(eosed);
    };

    const openOnRelay = (url: string, isRetry: boolean): void => {
      this.pool.ensureRelay(url, { connectionTimeout: 5000 })
        .then(relay => {
          if (callerClosed) return;
          this.instrumentRelay(relay);
          logRelayReq(url, filterSummary);
          recordReqOpened(url, filterSummary);
          const sub = relay.subscribe(filters, {
            alreadyHaveEvent: (id: string) => {
              if (_knownIds.has(id)) return true;
              _knownIds.add(id);
              return false;
            },
            onevent: (event: Event) => {
              // Track which relay this event was seen on
              this.trackEventSeenOn(event.id, relay);
              this.primeEventCache(event);
              onevent?.(event);
            },
            oneose: () => {
              if (isRetry) {
                // A retried sub reaching EOSE is the relay answering again
                // after its cooldown — the same evidence rule the one-shot
                // query path uses to clear strike history.
                this.noteRelayAnswered(url);
              } else {
                noteEose();
              }
            },
            onclose: (reason: string) => {
              activeSubs.delete(url);
              // 'closed by caller' is our own sub.close(); anything else is
              // the relay ending the subscription (CLOSED frame reason, or
              // 'relay connection closed/errored' on a dropped socket).
              if (reason !== 'closed by caller') {
                logRelayClosed(url, `${reason} — REQ ${filterSummary}`);
                if (ClientService.isRateLimitReason(reason)) {
                  this.markRelayRateLimited(url);
                  // Standing subs must outlive the cooldown: re-open once
                  // it lapses (repeat offenders escalate the cooldown, so
                  // this cannot spiral).
                  if (!callerClosed) {
                    const cooldown = this.relayCooldowns.get(url);
                    const delay = Math.max((cooldown?.until ?? 0) - Date.now(), RELAY_COOLDOWN_BASE_MS);
                    const timer = setTimeout(() => {
                      retryTimers.delete(timer);
                      if (!callerClosed) openOnRelay(url, true);
                    }, delay);
                    retryTimers.add(timer);
                  }
                }
              }
              recordReqClosed(url);
              if (!isRetry) {
                closedCount++;
                closeReasons.push(reason);
                if (closedCount >= startedCount) {
                  onclose?.(closeReasons);
                }
              }
            }
          });
          activeSubs.set(url, sub);
          if (callerClosed) {
            try { sub.close(); } catch { /* already gone */ }
          }
        })
        .catch(error => {
          logRelayError(url, error);
          // Failed connections count toward the EOSE tally.
          if (!isRetry) noteEose();
        });
    };

    relays.forEach((url) => openOnRelay(url, false));

    return {
      close: () => {
        callerClosed = true;
        retryTimers.forEach((t) => clearTimeout(t));
        retryTimers.clear();
        activeSubs.forEach((sub) => {
          try {
            sub.close();
          } catch (err) {
            // sub.close() throws synchronously when the relay WebSocket is
            // already disconnected (e.g. during reconnect). Safe to ignore.
            console.debug('ClientService: Ignoring close on dead connection:', err);
          }
        });
        activeSubs.clear();
      }
    };
  }

  
  /**
   * Like query(), but also reports how many relays reached EOSE. An empty
   * result with eoseCount 0 means NO relay actually answered (still
   * connecting, all refused, network down) — callers must treat that as
   * "unknown", never as "the event does not exist".
   */
  async queryWithStats(
    urls: string[],
    filter: Filter | Filter[],
    onevent?: (evt: Event) => void,
    options: { eoseDeadlineMs?: number; isComplete?: (events: Event[]) => boolean } = {}
  ): Promise<{ events: Event[]; eoseCount: number }> {
    const eoseDeadlineMs = options.eoseDeadlineMs ?? QUERY_EOSE_DEADLINE;
    const relays = this.filterCoolingRelays(Array.from(new Set(urls)));
    const filters = Array.isArray(filter) ? filter : [filter];

    // Log query creation
    const queriedKinds: number[] = [];
    filters.forEach((f: Filter) => {
      if (f.kinds) {
        f.kinds.forEach(k => {
          if (k !== undefined) queriedKinds.push(k);
        });
      }
    });
    const kindsStr = queriedKinds.length > 0 ? `kinds ${queriedKinds.join(',')}` : '';
    console.debug(`🤖⬆️ Query for ${kindsStr}`);
    const filterSummary = ClientService.summarizeFilters(filters);

    const _knownIds = new Set<string>();
    const events: Event[] = [];
    let eoseCount = 0;

    // Early completion: once the caller's predicate is satisfied by the
    // events received so far, every relay's REQ is closed and the query
    // resolves — a fully-answered batch must not wait out the per-relay
    // deadline of a slow or silent relay.
    const earlyClosers: (() => void)[] = [];
    let completedEarly = false;
    const maybeCompleteEarly = (): void => {
      if (completedEarly || !options.isComplete) return;
      if (!options.isComplete(events)) return;
      completedEarly = true;
      earlyClosers.forEach((close) => close());
    };

    await Promise.all(
      relays.map(async (url) => {
        try {
          const relay = await this.pool.ensureRelay(url);
          // Query already satisfied while this relay was connecting.
          if (completedEarly) return;
          this.instrumentRelay(relay);
          logRelayReq(url, filterSummary);
          recordReqOpened(url, filterSummary);

          await new Promise<void>((resolve) => {
            // Timeout to close the subscription if the relay never EOSEs
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            // Set once this relay's outcome is decided (EOSE, CLOSED, or our
            // deadline) — nostr-tools fires a SYNTHETIC oneose from a timer
            // that even close() doesn't cancel, so a late oneose after a
            // relay refused the REQ must not count as "relay answered".
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              recordReqClosed(url);
              if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
              }
              resolve();
            };

            const sub = relay.subscribe(filters, {
              // Push the synthetic-EOSE timer past our own deadline so oneose
              // can only fire for a REAL relay EOSE message.
              eoseTimeout: eoseDeadlineMs + 5000,
              onevent: (event: Event) => {
                if (_knownIds.has(event.id)) return;
                _knownIds.add(event.id);
                events.push(event);
                onevent?.(event);

                // Add to cache
                this.primeEventCache(event);

                // Track which relay this event was seen on
                this.trackEventSeenOn(event.id, relay);

                maybeCompleteEarly();
              },
              oneose: () => {
                if (!settled) {
                  eoseCount++;
                  this.noteRelayAnswered(url);
                }
                sub.close();
                finish();
              },
              onclose: (reason: string) => {
                // Relay-initiated close (CLOSED frame or dropped socket):
                // log the relay's reason and settle now instead of hanging
                // on this relay until the deadline.
                if (reason !== 'closed by caller') {
                  logRelayClosed(url, `${reason} — REQ ${filterSummary}`);
                  if (ClientService.isRateLimitReason(reason)) {
                    this.markRelayRateLimited(url);
                  }
                }
                finish();
              }
            });

            // A silent relay (no EOSE, no CLOSED) gets its REQ closed at the
            // deadline WITHOUT counting toward eoseCount: one-shot REQs must
            // not occupy relay subscription slots for the full query timeout.
            timeoutHandle = setTimeout(() => {
              sub.close();
              finish();
            }, eoseDeadlineMs);

            if (completedEarly) {
              // Another relay satisfied the predicate between our
              // subscribe and here — release this REQ immediately.
              sub.close();
              finish();
              return;
            }
            earlyClosers.push(() => {
              sub.close();
              finish();
            });
            // The predicate may already hold (events served from a faster
            // relay before this one connected).
            maybeCompleteEarly();
          });
        } catch (error) {
          logRelayError(url, error);
        }
      })
    );

    return { events, eoseCount };
  }
  
  
    /** Install an event in the by-id cache. */
  private primeEventCache(event: Event): void {
    this.eventDataLoader.prime(event.id, event);
  }

  /**
   * Add an event to the cache
   */
  addEventToCache(event: Event) {
    this.primeEventCache(event);
  }
  
  
  /**
   * Fetch a profile event by pubkey
   */
  async fetchProfileEvent(pubkey: string): Promise<Event | undefined> {
    return this.replaceableEventLoader.load({ pubkey, kind: kinds.Metadata });
  }

  /**
   * Fetch multiple profile events by pubkey
   */
  async fetchProfileEvents(pubkeys: string[]): Promise<(Event | undefined)[]> {
    return this.replaceableEventLoader.loadMany(
      pubkeys.map((pubkey) => ({ pubkey, kind: kinds.Metadata }))
    );
  }

  /**
   * Drop a pubkey's cached kind-0 (and any recorded miss) so the next fetch
   * hits the relays — the loader-level half of a profile force refresh.
   */
  clearProfileEvent(pubkey: string): void {
    this.replaceableEventLoader.clear({ pubkey, kind: kinds.Metadata });
  }

  
  /**
   * Convert relay input to an array of relay URLs. An explicit relay list is
   * MANDATORY — see the write-containment note in the body.
   */
  private getRelayUrls(relays?: RelayList | string[] | null): string[] {
    // WRITE CONTAINMENT: every publish must name its target relays. There
    // is deliberately no fallback to a default write set — a caller that
    // forgets cannot silently reach the public network.
    if (!relays || (Array.isArray(relays) && relays.length === 0)) {
      throw new Error('publishEvent requires an explicit relay list');
    }
    if (Array.isArray(relays)) {
      return relays;
    }
    return [...(relays.read || []), ...(relays.write || [])];
  }
  
  /**
   * Publish an event to relays
   */
  async publishEvent(
    event: Event,
    userRelays?: RelayList | string[] | null
  ): Promise<Record<string, boolean>> {
    const relayUrls = this.getRelayUrls(userRelays);
    console.debug(`🤖⬆️ Publishing kind ${event.kind} to ${relayUrls.length} relays`);

    // We signed this event ourselves — relay echoes need no Schnorr verify.
    markEventVerified(event.id);
    
    const uniqueRelayUrls = Array.from(new Set<string>(relayUrls));
    const results: Record<string, boolean> = {};
    
    // Initialize all results as false
    uniqueRelayUrls.forEach(url => {
      results[url] = false;
    });
    
    // Create a promise that resolves when any relay succeeds
    const publishPromises = uniqueRelayUrls.map(async (url) => {
      try {
        const relay = await this.pool.ensureRelay(url, {
          connectionTimeout: 8000
        });
        this.instrumentRelay(relay);

        await relay.publish(event);
        results[url] = true;
        return true; // Success
      } catch (error) {
        logRelayError(url, error);
        return false; // Failure
      }
    });
    
    // Wait for all publish attempts to complete
    await Promise.all(publishPromises);

    // Add to cache
    this.addEventToCache(event);

    // Write-through: a published replaceable event IS the newest version of
    // its coordinate — prime the loader so follow-up fetches (follow list
    // after a follow, mute list after a mute, …) see it immediately instead
    // of a stale cache entry or a recorded miss. Only when some relay
    // accepted it: a fully failed publish never reached the network.
    if (
      CACHEABLE_REPLACEABLE_KINDS.has(event.kind) &&
      Object.values(results).some(Boolean)
    ) {
      this.replaceableEventLoader.prime(event);
    }

    return results;
  }
  
  /**
   * Track which relay an event was seen on
   */
  private trackEventSeenOn(eventId: string, relay: any): void {
    // Use the pool's seenOn map if available
    if (this.pool.seenOn) {
      let set = this.pool.seenOn.get(eventId);
      if (!set) {
        set = new Set();
        this.pool.seenOn.set(eventId, set);
      }
      set.add(relay);
    }
  }
  
  
  
  /**
   * List connection status for all relays
   */
  listConnectionStatus() {
    return this.pool.listConnectionStatus();
  }

  /**
   * Periodically log relay connection health when disconnections are detected.
   * nostr-tools handles actual reconnection via enableReconnect; this is for observability.
   */
  private startConnectionMonitor(): void {
    this.connectionMonitorInterval = setInterval(() => {
      try {
        const status = this.listConnectionStatus();
        if (status.size === 0) return;

        const connected = Array.from(status.values()).filter(Boolean).length;
        const total = status.size;

        if (connected < total) {
          logWithTime(`ClientService: Connection health: ${connected}/${total} relays connected`);
          status.forEach((isConnected, url) => {
            if (!isConnected) {
              logWithTime(`ClientService: Relay disconnected (auto-reconnecting): ${url}`);
            }
          });
        }
      } catch {
        // Silently ignore errors in the monitor
      }
    }, 60000);
    // Don't let this interval keep the Node.js process alive (important for Jest/CI).
    // In browsers, unref() doesn't exist on the return value — guard accordingly.
    if (this.connectionMonitorInterval && typeof this.connectionMonitorInterval === 'object' && 'unref' in this.connectionMonitorInterval) {
      this.connectionMonitorInterval.unref();
    }
  }


  

  /**
   * Attempt to fight Amber render storms with inflight tracking and a short cache
   * Hash event request parameters for deduplication
   * Excludes created_at to handle timestamp variance
   */
  private hashEventRequest(kind: number, content: string, tags: string[][], pubkey: string): string {
    const hashInput = JSON.stringify({ kind, content, tags, pubkey });
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const char = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return hash.toString(16);
  }
  
  /**
   * Create and sign an event with deduplication to prevent signature storms
   * @param signer The signer to use
   * @param kind The event kind
   * @param content The event content
   * @param tags The event tags
   * @returns Promise that resolves to the signed event
   */
  async createSignedEvent(
    signer: ISigner,
    kind: number,
    content: string,
    tags: string[][] = []
  ): Promise<Event> {
    const signerLabel = signer?.constructor?.name ?? 'UnknownSigner';
    const pubkey = await withTimeout(Promise.resolve().then(() => signer.getPublicKey()), {
      ms: SIGNER_OPERATION_TIMEOUT_MS,
      message: `Timed out getting pubkey from signer (${signerLabel}) after ${SIGNER_OPERATION_TIMEOUT_MS}ms`,
    });

    // Create hash for deduplication (excluding created_at)
    const eventHash = this.hashEventRequest(kind, content, tags, pubkey);

    // Check for cached event first
    const cachedEvent = this.signedEventCache.get(eventHash);
    if (cachedEvent) {
      return cachedEvent;
    }

    // Check for inflight request
    const inflightPromise = this.inflightRequests.get(eventHash);
    if (inflightPromise) {
      return inflightPromise;
    }

    // Create new signing request
    const signingPromise = this.performSigning(signer, kind, content, tags, pubkey);

    // Store the promise in inflight map
    this.inflightRequests.set(eventHash, signingPromise);

    try {
      const signedEvent = await signingPromise;

      // Store in cache for future requests
      this.signedEventCache.set(eventHash, signedEvent);

      // Set up cleanup timers
      setTimeout(() => {
        this.signedEventCache.delete(eventHash);
      }, 10000); // 10-second cache

      return signedEvent;
    } finally {
      // Remove from inflight map
      this.inflightRequests.delete(eventHash);
    }
  }
  
  /**
   * Internal method to perform the actual signing
   */
  private async performSigning(
    signer: ISigner,
    kind: number,
    content: string,
    tags: string[][],
    pubkey: string
  ): Promise<Event> {
    let finalTags = tags;
    if (this.clientName) {
      finalTags = [...tags, ['client', this.clientName]];
    }

    const eventTemplate: EventTemplate = {
      kind,
      content,
      tags: finalTags,
      created_at: Math.floor(Date.now() / 1000)
    };

    const signerLabel = signer?.constructor?.name ?? 'UnknownSigner';
    return await withTimeout(Promise.resolve().then(() => signer.signEvent(eventTemplate)), {
      ms: SIGNER_OPERATION_TIMEOUT_MS,
      message: `Timed out signing event (kind ${kind}) via signer (${signerLabel}) after ${SIGNER_OPERATION_TIMEOUT_MS}ms`,
    });
  }

  
  
  /**
   * Close all connections
   */
  close(): void {
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval);
      this.connectionMonitorInterval = undefined;
    }

    // Close every connection the pool actually holds, not just the relays in
    // the current config — a pool can hold sockets to host write relays and
    // relays from a since-changed relay list.
    const readRelays = relayService.getReadRelays();
    const writeRelays = relayService.getWriteRelays();
    const pooledRelays = Array.from(this.pool.listConnectionStatus().keys());
    const allRelays = Array.from(new Set([...readRelays, ...writeRelays, ...pooledRelays]));

    logWithTime(`ClientService: Closing ${allRelays.length} relay connections`);
    this.pool.close(allRelays);
  }
}

// Export a singleton instance
const clientService = ClientService.getInstance();
export default clientService;
