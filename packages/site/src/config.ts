/**
 * Every external address the page knows about, in one place.
 *
 * This file exists rather than URLs scattered through the markup because
 * staging and production differ only by these values — a build var, not a
 * code edit.
 */

const env = import.meta.env;

/** Never put anything here that isn't already public — Vite inlines it into the bundle. */
export const config = {
  /** Durable discovery events: every kind-30311 the bridge publishes. Public reads. */
  eventRelay: env.VITE_EVENT_RELAY ?? 'wss://livestream.livelier.live',
  /** Chat-session events: bridged 1311s, channel kind-0s. Strict kinds, 3h TTL. */
  chatRelay: env.VITE_CHAT_RELAY ?? 'wss://livechat.livelier.live',

  /**
   * What the cards call each relay. Their NIP-11 documents carry their own
   * `name` field, set by RELAY_NAME on the deployment; these are the labels
   * this page uses so the two cards read as a pair regardless of what a given
   * environment happens to be called.
   */
  eventRelayLabel: 'Livelier live stream relay',
  chatRelayLabel: 'Livelier live chat relay',

  /** Source prefix on every Owncast d-tag (`oc-<16 hex>`), from the bridge's OwncastAdapter. */
  owncastDTagPrefix: 'oc',

  /**
   * The `client` tag the bridge stamps on everything it signs (BRIDGE_NAME on
   * the worker). It is how a message the bridge created is told apart from one
   * a Nostr client posted straight to the chat relay.
   */
  bridgeName: 'Livelier',

  repo: 'https://github.com/r0d8lsh0p/livelier',
  newIssue: 'https://github.com/r0d8lsh0p/livelier/issues/new',

  sw2Repo: 'https://github.com/bitvora/sw2',
  ephemeralRelayRepo: 'https://github.com/r0d8lsh0p/ephemeral-relay',

  /** Grimoire runs the same command strings as nak, in a browser tab. */
  grimoireRun: 'https://grimoire.rocks/run?cmd=',
  nakRepo: 'https://github.com/fiatjaf/nak',

  /** Third-party Nostr event viewer — someone else's rendering of our event. */
  njump: 'https://njump.me/',

  nip: (n: number) => `https://github.com/nostr-protocol/nips/blob/master/${String(n).padStart(2, '0')}.md`,
} as const;

/** `wss://host` → `https://host`, for NIP-11 and for display. */
export function relayHttpUrl(wssUrl: string): string {
  return wssUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/** Bare hostname, for labels and command snippets. */
export function relayHost(wssUrl: string): string {
  return wssUrl.replace(/^wss?:\/\//, '').replace(/\/$/, '');
}
