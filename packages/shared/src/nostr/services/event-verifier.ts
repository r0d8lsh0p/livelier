import { Event, VerifiedEvent, verifyEvent as verifyEventPure } from 'nostr-tools';

/**
 * Cache-backed Nostr event verification.
 *
 * Schnorr verification in pure JS (@noble/curves) is not free. Because the
 * client opens one subscription per relay (for provenance and per-relay
 * lifecycle), the same event arrives — and would be re-verified — once per
 * relay carrying it, and again on every reconnect replay. Profiling showed
 * repeat verification dominating the cost of a busy cold start.
 *
 * This verifier runs the full Schnorr check only the first time an event ID
 * is seen; a repeat sighting is trusted outright. This is the same
 * verified-once model as Amethyst (LocalCache returns before re-verifying a
 * known ID) and Jumble (persisted events re-enter without re-verification).
 * A malicious relay could replay a known ID with tampered content, but every
 * store dedupes by event ID and keeps the first-seen copy, so the tampered
 * copy is dropped before rendering. (An earlier revision re-hashed cache
 * hits; at ~2,000 duplicate deliveries per cold start the sha256 alone cost
 * ~17s of JS time on device-class hardware — measurably worse than the
 * exposure it closed.)
 */

declare const __DEV__: boolean | undefined;
const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

/** FIFO-evicted set of event IDs whose signatures have already been verified.
 *  64-char hex IDs at 20k entries ≈ 2.5MB upper bound. */
const MAX_VERIFIED_IDS = 20000;
const verifiedIds = new Set<string>();

function rememberVerified(id: string): void {
  if (verifiedIds.size >= MAX_VERIFIED_IDS) {
    const oldest = verifiedIds.values().next().value;
    if (oldest !== undefined) verifiedIds.delete(oldest);
  }
  verifiedIds.add(id);
}

export interface VerifyStats {
  schnorrCount: number;
  schnorrMs: number;
  cacheHits: number;
  hashOnlyMs: number;
  rejectedCount: number;
}

const stats: VerifyStats = {
  schnorrCount: 0,
  schnorrMs: 0,
  cacheHits: 0,
  hashOnlyMs: 0,
  rejectedCount: 0
};

// Dev-only: which event kinds pay for full Schnorr verifies.
const schnorrByKind = new Map<number, number>();

export function getVerifyStats(): VerifyStats {
  return { ...stats };
}

export function resetVerifyStats(): void {
  stats.schnorrCount = 0;
  stats.schnorrMs = 0;
  stats.cacheHits = 0;
  stats.hashOnlyMs = 0;
  stats.rejectedCount = 0;
  verifiedIds.clear();
}

// Dev-only diagnostics ticker: reports verification workload and event-loop
// drift so before/after measurements can be read from the logs.
let devTicker: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let lastLogged: VerifyStats = { ...stats };

function ensureDevTicker(): void {
  if (!isDev || devTicker) return;
  lastTickAt = Date.now();
  devTicker = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTickAt - 10000;
    lastTickAt = now;
    const delta = stats.schnorrCount - lastLogged.schnorrCount + stats.cacheHits - lastLogged.cacheHits;
    if (delta === 0) return;
    lastLogged = { ...stats };
    const kinds = [...schnorrByKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => `${k}:${n}`)
      .join(' ');
    console.log(
      `[verify-stats] schnorr=${stats.schnorrCount} (${Math.round(stats.schnorrMs)}ms) ` +
      `cacheHits=${stats.cacheHits} ` +
      `rejected=${stats.rejectedCount} loop-drift=${drift}ms kinds[${kinds}]`
    );
  }, 10000);
}

/** Mark an event ID as verified without running Schnorr — for events the client
 *  itself just signed, whose relay echoes would otherwise pay a full verify. */
export function markEventVerified(id: string): void {
  rememberVerified(id);
}

/**
 * Drop-in replacement for nostr-tools' verifyEvent, injected at pool
 * construction. Full Schnorr on first sight of an event ID; repeats are
 * trusted (see the module doc for the store-level dedup that backs this).
 */
export function cachedVerifyEvent(event: Event): event is VerifiedEvent {
  ensureDevTicker();

  if (
    typeof event.id !== 'string' || event.id.length !== 64 ||
    typeof event.pubkey !== 'string' || event.pubkey.length !== 64 ||
    typeof event.sig !== 'string' || event.sig.length !== 128
  ) {
    stats.rejectedCount++;
    return false;
  }

  if (verifiedIds.has(event.id)) {
    stats.cacheHits++;
    return true;
  }

  const t0 = Date.now();
  const ok = verifyEventPure(event);
  stats.schnorrMs += Date.now() - t0;
  stats.schnorrCount++;
  if (isDev) schnorrByKind.set(event.kind, (schnorrByKind.get(event.kind) ?? 0) + 1);
  if (ok) {
    rememberVerified(event.id);
  } else {
    stats.rejectedCount++;
  }
  return ok;
}
