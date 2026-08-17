/**
 * Bridge configuration, resolved from environment.
 *
 * Global (core) settings share the bridge identity, relays, and DB across all
 * sources; each source gets its own prefixed block (OWNCAST_*) so
 * sources — and their discovery vs chat halves — enable independently.
 *
 * The only relays any publish path may reach are the ones configured here.
 * There is deliberately no "default relays" fallback — an unset relay URL is
 * an error, never a silent fallback to the public network.
 */

import { NETWORK_CHAT_READ_RELAYS, NETWORK_PROFILE_WRITE_RELAYS } from './core/relays';

/** Settings shared by every source. */
export interface CoreConfig {
  /**
   * Public-facing bridge name ("Livelier", livelier.live); used as the
   * `client` tag on every event. The bridge identity's own kind-0 is curated
   * by the operator out-of-band — the bridge never writes it.
   */
  bridgeName: string;
  /**
   * The bridge identity's nsec — the author key of every 30311 and the bridge
   * kind-0. Lives in .env (gitignored). When unset, the key is
   * derived from BRIDGE_KEY_SECRET as a fallback.
   */
  bridgeNsec: string | null;
  /** Default relay when EVENT_RELAY_URL/CHAT_RELAY_URL are unset (single-relay setups). */
  localRelayUrl: string;
  /**
   * Relay for durable discovery events — 30311s and per-instance host
   * kind-0s (the SW2 "only we publish" relay). Defaults to
   * localRelayUrl for single-relay setups.
   */
  eventRelayUrl: string;
  /**
   * Relay for chat-session events — bridged 1311s and ephemeral chatter
   * identities (the strict TTL relay). The firehose subscription and /demand
   * endpoint live here too. Defaults to localRelayUrl.
   */
  chatRelayUrl: string;
  /** Secret for deterministic per-instance key derivation. Env-only, never committed. */
  bridgeKeySecret: string;
  /** Postgres connection string for instance state. */
  databaseUrl: string;
  /**
   * NIP-40 lifetime (seconds) stamped on every bridged 1311. Bridged chatters
   * never chose to be on Nostr, so their mirrored messages must expire; this
   * mirrors the strict relay's own TTL.
   */
  chatExpirationSeconds: number;
  /**
   * The relay's GET /demand endpoint (ephemeral-relay feature). When set, the
   * source-side chat listener for a room is opened only once a Nostr viewer
   * subscription names its `#a` (establish-only, never torn down while the
   * room lives). When unset, rooms connect eagerly.
   */
  demandUrl: string | null;
  /** Bearer token for the /demand endpoint (relay AUTH_TOKEN), if gated. */
  demandAuthToken: string | null;
  /** How often to poll /demand (ms). */
  demandPollIntervalMs: number;
  /**
   * The WRITE gate (NETWORK_PROFILE_PUBLISH_ENABLED, default false): fan
   * bridged kind-0/10002s out to the network profile-write set. Reads are
   * never gated — but publishes are permanent, and each environment derives
   * different keys for the same channels, so ONLY ONE environment (prod, at
   * launch) may ever hold this flag. The boot log warns loudly when set.
   */
  networkProfilePublishEnabled: boolean;
  /**
   * The firehose product gate (NETWORK_CHAT_READ_ENABLED, default false):
   * also read chat kinds for our rooms from the network read set. A read is
   * harmless to the network — this flag exists because delivering network
   * events into source-platform chats is a product-rollout decision.
   */
  networkChatReadEnabled: boolean;
  /** Profile-write set; env-overridable so tests can use local dummy relays. */
  networkProfileWriteRelays: readonly string[];
  /** Network chat-read set; env-overridable so tests can use local dummy relays. */
  networkChatReadRelays: readonly string[];
}

/** The Owncast source block (OWNCAST_* env vars). */
export interface OwncastSourceConfig {
  /** Master gate for the source (OWNCAST_ENABLED, default true). */
  enabled: boolean;
  /** Gate for the discovery loop alone (OWNCAST_DISCOVERY_ENABLED, default true). */
  discoveryEnabled: boolean;
  /** Owncast directory feed. */
  directoryUrl: string;
  /** How often to poll the directory (ms). */
  pollIntervalMs: number;
  /** How often to republish a live kind-30311 while still live (ms). */
  republishIntervalMs: number;
  /** How often to capture a raw observation snapshot of the live set (ms). */
  snapshotIntervalMs: number;
  /** HLS liveness fetch timeout (ms). */
  hlsTimeoutMs: number;
  /** Consecutive liveness failures before flipping an instance to ended. */
  maxConsecutiveFailures: number;
  /** Chat gate: bridge Owncast chat → Nostr kind-1311 (allowlisted rooms only). */
  chatToNostr: boolean;
  /** Chat gate: deliver Nostr kind-1311 → Owncast chat (allowlisted rooms only). */
  chatFromNostr: boolean;
  /**
   * Default posture stamped onto NEWLY discovered rows
   * (OWNCAST_DEFAULT_DISCOVERY_ENABLED, default true): whether new instances
   * publish to the relays. Existing rows are never swept to match — changing
   * posture for them is a deliberate scripted backfill (operations/).
   */
  defaultDiscoveryEnabled: boolean;
  /** Same, for chat_enabled on new rows (OWNCAST_DEFAULT_CHAT_ENABLED, default false). */
  defaultChatEnabled: boolean;
}

export interface BridgeConfig {
  core: CoreConfig;
  owncast: OwncastSourceConfig;
}

function boolFromEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function listFromEnv(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Load and validate config. Throws if a required secret/URL is missing so the
 * process fails fast rather than silently doing nothing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const bridgeKeySecret = env.BRIDGE_KEY_SECRET ?? '';
  const databaseUrl = env.DATABASE_URL ?? '';
  const localRelayUrl = env.LOCAL_RELAY_URL ?? '';

  const missing: string[] = [];
  if (!bridgeKeySecret) missing.push('BRIDGE_KEY_SECRET');
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!localRelayUrl) missing.push('LOCAL_RELAY_URL');
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const eventRelayUrl = env.EVENT_RELAY_URL || localRelayUrl;
  const chatRelayUrl = env.CHAT_RELAY_URL || localRelayUrl;

  return {
    core: {
      bridgeName: env.BRIDGE_NAME ?? 'Livelier',
      bridgeNsec: env.BRIDGE_NSEC ?? null,
      localRelayUrl,
      eventRelayUrl,
      chatRelayUrl,
      bridgeKeySecret,
      databaseUrl,
      chatExpirationSeconds: intFromEnv(env.CHAT_EXPIRATION_SECONDS, 3 * 60 * 60),
      demandUrl: env.DEMAND_URL || null,
      demandAuthToken: env.DEMAND_AUTH_TOKEN || null,
      demandPollIntervalMs: intFromEnv(env.DEMAND_POLL_INTERVAL_MS, 10_000),
      networkProfilePublishEnabled: boolFromEnv(env.NETWORK_PROFILE_PUBLISH_ENABLED),
      networkChatReadEnabled: boolFromEnv(env.NETWORK_CHAT_READ_ENABLED),
      networkProfileWriteRelays:
        listFromEnv(env.NETWORK_PROFILE_WRITE_RELAYS) ?? NETWORK_PROFILE_WRITE_RELAYS,
      networkChatReadRelays:
        listFromEnv(env.NETWORK_CHAT_READ_RELAYS) ?? NETWORK_CHAT_READ_RELAYS,
    },
    owncast: {
      enabled: boolFromEnv(env.OWNCAST_ENABLED, true),
      discoveryEnabled: boolFromEnv(env.OWNCAST_DISCOVERY_ENABLED, true),
      directoryUrl: env.OWNCAST_DIRECTORY_URL ?? 'https://owncast.directory/api/home',
      pollIntervalMs: intFromEnv(env.OWNCAST_POLL_INTERVAL_MS, 60_000),
      republishIntervalMs: intFromEnv(env.OWNCAST_REPUBLISH_INTERVAL_MS, 15 * 60_000),
      snapshotIntervalMs: intFromEnv(env.OWNCAST_SNAPSHOT_INTERVAL_MS, 60 * 60_000),
      hlsTimeoutMs: intFromEnv(env.OWNCAST_HLS_TIMEOUT_MS, 10_000),
      maxConsecutiveFailures: intFromEnv(env.OWNCAST_MAX_CONSECUTIVE_FAILURES, 3),
      chatToNostr: boolFromEnv(env.OWNCAST_CHAT_TO_NOSTR),
      chatFromNostr: boolFromEnv(env.OWNCAST_CHAT_FROM_NOSTR),
      defaultDiscoveryEnabled: boolFromEnv(env.OWNCAST_DEFAULT_DISCOVERY_ENABLED, true),
      defaultChatEnabled: boolFromEnv(env.OWNCAST_DEFAULT_CHAT_ENABLED),
    },
  };
}
