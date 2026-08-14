/**
 * Structured logging helpers for relay and network operations.
 *
 * Every function emits logs with a fixed, grep-friendly prefix so that
 * log consumers can efficiently filter process output:
 *
 *   grep '\[RELAY_ERROR\]'        — relay connection failures
 *   grep '\[RELAY_TIMEOUT\]'      — relay timeouts
 *   grep '\[RELAY_CONNECTED\]'    — successful connections
 *   grep '\[RELAY_NOTICE\]'       — NOTICE frames sent by a relay
 *   grep '\[RELAY_CLOSED\]'       — subscriptions closed by the relay side
 *   grep '\[RELAY_REQ\]'          — every outgoing REQ, per relay, with filter summary
 *   grep '\[RELAY_REQ_RATE\]'     — per-relay REQs/min + open-sub gauge (60s windows)
 *   grep '\[RELAY_COOLDOWN\]'     — relay put on / released from rate-limit cooldown
 *   grep '\[NETWORK_ERROR\]'      — general network errors
 */

export const RELAY_ERROR_PREFIX = '[RELAY_ERROR]';
export const RELAY_TIMEOUT_PREFIX = '[RELAY_TIMEOUT]';
export const RELAY_CONNECTED_PREFIX = '[RELAY_CONNECTED]';
export const RELAY_NOTICE_PREFIX = '[RELAY_NOTICE]';
export const RELAY_CLOSED_PREFIX = '[RELAY_CLOSED]';
export const RELAY_REQ_PREFIX = '[RELAY_REQ]';
export const RELAY_REQ_RATE_PREFIX = '[RELAY_REQ_RATE]';
export const RELAY_COOLDOWN_PREFIX = '[RELAY_COOLDOWN]';
export const NETWORK_ERROR_PREFIX = '[NETWORK_ERROR]';

function ts(): string {
  return new Date().toISOString();
}

function reasonStr(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return String(reason);
}

export function logRelayError(relayUrl: string, reason: unknown): void {
  console.warn(
    `${ts()} ${RELAY_ERROR_PREFIX}`,
    relayUrl,
    reasonStr(reason)
  );
}

export function logRelayTimeout(relayUrl: string, timeoutMs: number): void {
  console.warn(
    `${ts()} ${RELAY_TIMEOUT_PREFIX}`,
    relayUrl,
    `${timeoutMs}ms`
  );
}

export function logRelayConnected(relayUrl: string, durationMs: number): void {
  console.log(
    `${ts()} ${RELAY_CONNECTED_PREFIX}`,
    relayUrl,
    `${durationMs}ms`
  );
}

export function logRelayNotice(relayUrl: string, message: string): void {
  console.warn(
    `${ts()} ${RELAY_NOTICE_PREFIX}`,
    relayUrl,
    message
  );
}

/**
 * One line per outgoing REQ. High volume — debug level so it can be
 * filtered, but always emitted: rate-limit attribution needs the full
 * stream (relays count every REQ; so must we).
 */
export function logRelayReq(relayUrl: string, filterSummary: string): void {
  console.debug(
    `${ts()} ${RELAY_REQ_PREFIX}`,
    relayUrl,
    filterSummary
  );
}

export function logRelayClosed(relayUrl: string, reason: unknown): void {
  console.warn(
    `${ts()} ${RELAY_CLOSED_PREFIX}`,
    relayUrl,
    reasonStr(reason)
  );
}

export function logRelayCooldown(relayUrl: string, detail: string): void {
  console.warn(
    `${ts()} ${RELAY_COOLDOWN_PREFIX}`,
    relayUrl,
    detail
  );
}

export function logNetworkError(operation: string, reason: unknown): void {
  console.error(
    `${ts()} ${NETWORK_ERROR_PREFIX}`,
    operation,
    reasonStr(reason)
  );
}
