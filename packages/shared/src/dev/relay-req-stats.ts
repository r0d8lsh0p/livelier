import { RELAY_REQ_RATE_PREFIX } from './structured-log';

/**
 * Per-relay REQ accounting for rate-limit attribution.
 *
 * Relays enforce two different budgets and we need visibility into both:
 * - khatru's FilterIPRateLimiter is a token bucket on REQ RATE per IP —
 *   measured here as REQs per 60s window, broken down by filter summary.
 * - nostream's maxSubscriptions caps CONCURRENT open REQs per connection —
 *   measured here as the open-subscription gauge.
 *
 * One `[RELAY_REQ_RATE]` line per active relay per window, e.g.:
 *   [RELAY_REQ_RATE] wss://nos.lol 14 REQs/min open=3 — kinds=0 authors x2 ×9 | kinds=30311 ×5
 *
 * The window timer is armed lazily on the first record and re-armed only
 * while there is activity, so idle sessions (and test runs) hold no timer.
 */

const WINDOW_MS = 60_000;
/** Cap summary variants per relay per window so a pathological mix can't grow unbounded. */
const MAX_SUMMARIES_PER_RELAY = 20;

type RelayWindow = {
  count: number;
  bySummary: Map<string, number>;
};

const windows = new Map<string, RelayWindow>();
const openSubs = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Under jest, a live 60s timer outlives the test run ("Cannot log after
// tests are done"); recording still works, flushing is manual via
// flushRelayReqStatsNow().
const isTestEnv = typeof process !== 'undefined' && process.env.JEST_WORKER_ID !== undefined;

function armFlushTimer(): void {
  if (flushTimer !== null || isTestEnv) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushWindows();
  }, WINDOW_MS);
}

function flushWindows(): void {
  windows.forEach((window, relayUrl) => {
    const summaries = Array.from(window.bySummary.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([summary, count]) => `${summary} ×${count}`)
      .join(' | ');
    console.log(
      `${new Date().toISOString()} ${RELAY_REQ_RATE_PREFIX}`,
      relayUrl,
      `${window.count} REQs/min open=${openSubs.get(relayUrl) ?? 0} — ${summaries}`
    );
  });
  windows.clear();
}

/** Record an outgoing REQ to a relay. Call once per REQ frame sent. */
export function recordReqOpened(relayUrl: string, filterSummary: string): void {
  let window = windows.get(relayUrl);
  if (!window) {
    window = { count: 0, bySummary: new Map() };
    windows.set(relayUrl, window);
  }
  window.count += 1;
  if (
    window.bySummary.has(filterSummary) ||
    window.bySummary.size < MAX_SUMMARIES_PER_RELAY
  ) {
    window.bySummary.set(filterSummary, (window.bySummary.get(filterSummary) ?? 0) + 1);
  }
  openSubs.set(relayUrl, (openSubs.get(relayUrl) ?? 0) + 1);
  armFlushTimer();
}

/** Record a REQ ending (EOSE-closed, relay-closed, or closed by us). */
export function recordReqClosed(relayUrl: string): void {
  const current = openSubs.get(relayUrl) ?? 0;
  if (current <= 1) {
    openSubs.delete(relayUrl);
  } else {
    openSubs.set(relayUrl, current - 1);
  }
}

/** Current open-subscription gauge, for debug surfaces. */
export function getOpenSubCounts(): Map<string, number> {
  return new Map(openSubs);
}

/** Flush the current windows to the log immediately (tests; timer does this live). */
export function flushRelayReqStatsNow(): void {
  flushWindows();
}

/** Test helper: clear all windows, gauges, and the pending flush timer. */
export function resetRelayReqStatsForTesting(): void {
  windows.clear();
  openSubs.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
