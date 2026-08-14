/**
 * Network relay sets and the read/write asymmetry that governs them:
 *
 * READS are unconstrained. A REQ against a public relay has zero network
 * footprint — profile lookups always use the shared profile stack's full
 * relay coverage, no flag. (The network chat firehose is also "just reads",
 * but it changes what lands in source-platform chats, so it keeps a flag as
 * a product-rollout gate, not a containment one.)
 *
 * WRITES are the real constraint. Publishing bridged identities to network
 * relays is permanent, attributable fan-out — and every environment derives
 * DIFFERENT keys for the same channels, so staging + local + prod publishing
 * would mint triplicate identities forever. NETWORK_PROFILE_PUBLISH_ENABLED
 * therefore defaults off and ONLY ONE environment (prod, at launch) may ever
 * hold it. See docs/security.md.
 */

/**
 * Where bridge-published kind-0s (instance/host profiles, the bridge
 * identity, and bridged chatter profiles + kind-10002s) are additionally
 * published WHEN THE PUBLISH FLAG IS ON. purplepag.es is the
 * profile-specialty relay virtually every client reads profiles from.
 */
export const NETWORK_PROFILE_WRITE_RELAYS: readonly string[] = Object.freeze([
  'wss://purplepag.es',
]);

/**
 * Where chat-kind events for our rooms are additionally read from, so a
 * correctly `#a`-tagged event that landed on the wrong relay still bridges.
 * Mirrors the earlier bridge implementation's coverage set.
 */
export const NETWORK_CHAT_READ_RELAYS: readonly string[] = Object.freeze([
  'wss://purplepag.es',
  'wss://relay.nostr.net',
  'wss://nostrelites.org',
  'wss://nostr.wine',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.snort.social',
]);

/**
 * The slice of core config the set functions need. The set fields default to
 * the constants above but are env-overridable (NETWORK_PROFILE_WRITE_RELAYS /
 * NETWORK_CHAT_READ_RELAYS) so test harnesses can point the "network" at
 * local dummy relays — test WRITES must never touch real public relays.
 */
export interface RelayFlagConfig {
  chatRelayUrl: string;
  /** The write gate: fan bridged kind-0/10002s out to the network. */
  networkProfilePublishEnabled: boolean;
  /** The firehose product gate: read chat kinds from the network set. */
  networkChatReadEnabled: boolean;
  networkProfileWriteRelays: readonly string[];
  networkChatReadRelays: readonly string[];
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

/** Every relay a bridge-published kind-0/10002 goes to. Always includes our chat relay. */
export function profileWriteRelays(config: RelayFlagConfig): string[] {
  if (!config.networkProfilePublishEnabled) return [config.chatRelayUrl];
  return dedupe([config.chatRelayUrl, ...config.networkProfileWriteRelays]);
}

/**
 * Network relays to additionally READ chat events from. Deliberately excludes
 * our own chat relay — the local unscoped 1311 firehose stays separate so it
 * never registers as viewer demand on /demand.
 */
export function networkChatReadRelays(config: RelayFlagConfig): string[] {
  if (!config.networkChatReadEnabled) return [];
  return config.networkChatReadRelays.filter((url) => url !== config.chatRelayUrl);
}
