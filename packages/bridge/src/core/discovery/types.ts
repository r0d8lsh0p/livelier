/**
 * The discovery seam between the source-agnostic lifecycle engine and a
 * source-network adapter (Owncast, PeerTube, Streamplace, …).
 *
 * The engine is deliberately poll-shaped even for push sources: a firehose
 * adapter consumes its subscription into an in-memory live-set and answers
 * `fetchLive()` from that set instantly, so the lifecycle machinery
 * (hash-gated profiles, heartbeat republish, failure-counted teardown,
 * snapshots) exists exactly once.
 */

import type { ProxyProtocol } from '../../../../shared/src/nostr/live-event-tags';

export type Liveness = 'live' | 'ended' | 'error';

/** A live stream discovered on the source directory, normalized. */
export interface DiscoveredLive {
  /** Canonical instance/channel URL — the identity key. */
  url: string;
  name: string;
  streamTitle: string;
  description: string;
  /** Absolute kind-0 picture URL. */
  picture: string;
  /** Preview/thumbnail image for the 30311. */
  image: string;
  /** Source self-declared NSFW; carried through as NIP-36, never filtered. */
  nsfw: boolean;
  /** Unix seconds the stream started, when the source reports it. */
  startsAt: number | null;
  /** Playable stream URL (HLS); liveness checks probe this. */
  streamUrl: string;
  /** Hashtag slugs for the 30311 `t` tags. */
  tags: string[];
}

export interface DiscoveryResult {
  live: DiscoveredLive[];
  /** Raw source objects of the live set, verbatim, for observation snapshots. */
  raw: unknown[];
  /** Fingerprint of the source schema; the engine logs drift. */
  schemaVersion: string;
}

export interface DiscoveryAdapter {
  /**
   * Short stable key: the DB `source` column, the key-derivation namespace,
   * and log labels. Changing it re-keys every bridged identity of the source.
   */
  readonly sourceKey: string;
  /** Human name of the network, used in profile copy ("… (Owncast)."). */
  readonly sourceName: string;
  /**
   * 2–3 char d-tag prefix. The full d-tag must stay under 30 chars —
   * nostrlib-based relays truncate the d-tag portion of their `#a` index at
   * 30 bytes and then silently fail to match, breaking client chat lookups.
   */
  readonly dTagPrefix: string;
  /** NIP-48 proxy tag protocol ('web', 'activitypub', 'atproto', …). */
  readonly proxyProtocol: ProxyProtocol;
  /** Current live set. Throws on source outage (engine keeps last state). */
  fetchLive(): Promise<DiscoveryResult>;
  /** Probe a stream URL for ground-truth liveness. */
  checkLiveness(streamUrl: string): Promise<Liveness>;
  /**
   * Poll the instance's live viewer count for NIP-53 `current_participants`.
   * Returns the count; `null` when the instance hides it; `undefined` when it
   * couldn't be determined this poll (network error — no signal, the engine
   * keeps its last-published value and takes no action).
   */
  fetchViewerCount?(instanceUrl: string): Promise<number | null | undefined>;
}
