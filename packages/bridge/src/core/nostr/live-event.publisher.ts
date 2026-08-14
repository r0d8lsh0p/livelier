import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';
import { nostrClient } from './client';
import { buildLiveEventTags, LiveEventStatus, ProxyProtocol } from '../../../../shared/src/nostr/live-event-tags';
import type { StreamMeta } from '../../../../shared/src/streaming/stream-meta';

/**
 * Publishes bridged Nostr events for a discovered instance. Every method
 * passes its target relay explicitly to `publishEvent`, so no publish can
 * reach any relay beyond the configured event/chat pair.
 *
 * Identity is neutral: events are signed by a per-instance derived key, carry a
 * NIP-48 `proxy` tag, and the kind-0 profile is clearly marked as an automated
 * mirror. No platform branding is attached anywhere.
 */

export interface BridgedProfileInput {
  name: string;
  description: string;
  /** Absolute picture URL (e.g. `<instance>/logo`). */
  picture: string;
  /** The instance origin. */
  website: string;
  /** Human name of the source network, e.g. "Owncast". */
  sourceName: string;
}

export interface LivePublishInput {
  /** The BRIDGE identity signer — the 30311 author (NIP-53 provider pattern). */
  signer: DerivedKeySigner;
  /** The instance's derived pubkey — stays the `p` host tag. */
  hostPubkey: string;
  dTag: string;
  metadata: StreamMeta;
  /** HLS URL of the stream. */
  streamingUrl: string;
  startsTimestamp: number;
  status: LiveEventStatus;
  /** The source instance origin, for the NIP-48 proxy tag. */
  proxyUrl: string;
  /** NIP-48 proxy protocol ('web', 'activitypub', 'atproto', …). */
  proxyProtocol: ProxyProtocol;
  /** The one relay to publish to (the durable event relay). */
  relayUrl: string;
  /**
   * Relay where the room's live chat (1311) lives; included in the NIP-53
   * `relays` hint so clients join the chat in the right place. Omit for
   * single-relay setups.
   */
  chatRelayUrl?: string;
  /**
   * Instance self-declared NSFW. Carried through as a NIP-36
   * `["content-warning", "nsfw"]` tag — the bridge does not filter.
   */
  nsfw: boolean;
  /**
   * Live viewer count for the NIP-53 `current_participants` tag. Omit when
   * the source hides or doesn't report it — the tag is then absent.
   */
  currentParticipants?: number;
}

/** Build the kind-0 content for a bridged instance, marked as a mirror. */
export function buildBridgedProfileContent(input: BridgedProfileInput): string {
  const about = input.description
    ? `${input.description}\n\nBridged mirror of ${input.website} (${input.sourceName}).`
    : `Bridged mirror of ${input.website} (${input.sourceName}).`;
  return JSON.stringify({
    name: input.name,
    display_name: input.name,
    about,
    picture: input.picture,
    website: input.website,
    bot: true,
  });
}

export class LiveEventPublisher {
  /** Publish (or refresh) the bridged kind-0 profile to every given relay. */
  async publishProfile(
    signer: DerivedKeySigner,
    input: BridgedProfileInput,
    relayUrls: string[]
  ): Promise<Record<string, boolean>> {
    const content = buildBridgedProfileContent(input);
    const event = await nostrClient.createSignedEvent(signer, 0, content, []);
    return nostrClient.publishEvent(event, relayUrls);
  }

  /**
   * Publish the bridge's own operator kind-0 — the author identity of every
   * 30311. Name is the configured bridge name.
   */
  async publishBridgeIdentity(
    signer: DerivedKeySigner,
    bridgeName: string,
    relayUrls: string[]
  ): Promise<Record<string, boolean>> {
    const content = JSON.stringify({
      name: bridgeName,
      display_name: bridgeName,
      about:
        'Bridges live Owncast streams from the public Owncast directory onto Nostr as NIP-53 live events, with NIP-48 proxy attribution. Automated service.',
      bot: true,
    });
    const event = await nostrClient.createSignedEvent(signer, 0, content, []);
    return nostrClient.publishEvent(event, relayUrls);
  }

  /**
   * Publish a kind-30311 live event with NIP-53 `relays` + NIP-48 `proxy` tags.
   * Signed by the bridge identity; the instance's derived key stays the `p` host.
   */
  async publishLiveEvent(input: LivePublishInput): Promise<Record<string, boolean>> {
    const tags = buildLiveEventTags({
      dTag: input.dTag,
      metadata: input.metadata,
      streamingUrl: input.streamingUrl,
      hostPubkey: input.hostPubkey,
      status: input.status,
      startsTimestamp: input.startsTimestamp,
      // Chat relay ONLY. Clients treat this hint as "where the 1311 room
      // lives" for both reading and writing (zap.stream additionally uses just
      // the first URL of the tag), so listing the write-whitelisted event
      // relay here would point their chat at a relay that rejects it.
      relays: [input.chatRelayUrl ?? input.relayUrl],
      proxy: { url: input.proxyUrl, protocol: input.proxyProtocol },
      contentWarning: input.nsfw ? 'nsfw' : undefined,
      currentParticipants: input.currentParticipants,
    });
    const event = await nostrClient.createSignedEvent(input.signer, 30311, '', tags);
    return nostrClient.publishEvent(event, [input.relayUrl]);
  }

  /**
   * NIP-09 retraction of an instance's 30311 by coordinate. Signed by the
   * bridge identity — the 30311's author, the only key relays accept a
   * deletion from (and the only key SW2 whitelists).
   */
  async retractLiveEvent(
    signer: DerivedKeySigner,
    dTag: string,
    relayUrl: string
  ): Promise<Record<string, boolean>> {
    const coordinate = `30311:${signer.getPublicKey()}:${dTag}`;
    const event = await nostrClient.createSignedEvent(signer, 5, 'instance opted out of bridging', [
      ['a', coordinate],
      ['k', '30311'],
    ]);
    return nostrClient.publishEvent(event, [relayUrl]);
  }

  /**
   * Retract an instance's kind-0 by replacement: kind 0 is replaceable, so a
   * blank profile overwrites the bridged one everywhere it was published —
   * no event id needed (we don't store ids; the relays are the record).
   */
  async blankProfile(
    signer: DerivedKeySigner,
    relayUrls: string[]
  ): Promise<Record<string, boolean>> {
    const event = await nostrClient.createSignedEvent(signer, 0, '{}', []);
    return nostrClient.publishEvent(event, relayUrls);
  }
}
