import type { StreamMeta } from '../streaming/stream-meta';

/**
 * NIP-53 live event status values.
 */
export type LiveEventStatus = 'planned' | 'live' | 'ended';

/**
 * NIP-48 proxy protocols. Owncast (and any generic HTTP source) maps to `web`.
 */
export type ProxyProtocol = 'activitypub' | 'atproto' | 'rss' | 'web';

/**
 * NIP-48 proxy attribution for a bridged/mirrored live event.
 */
export interface LiveEventProxy {
  /** Origin URL of the upstream source being proxied (e.g. the Owncast instance). */
  url: string;
  /** Defaults to `web`. */
  protocol?: ProxyProtocol;
}

export interface LiveEventTagParams {
  dTag: string;
  metadata: StreamMeta;
  streamingUrl: string;
  hostPubkey: string;
  status: LiveEventStatus;
  startsTimestamp: number;
  /**
   * NIP-53 `relays` hint. Clients use this to decide where to publish kind-1311
   * chat for the room. The bridge sets this to the single bridge relay so all
   * chat is steered there.
   */
  relays?: string[];
  /**
   * NIP-48 proxy attribution. When set, an honest `["proxy", url, protocol]`
   * tag is emitted so the event is transparently a mirror, not an impersonation.
   */
  proxy?: LiveEventProxy;
  /**
   * NIP-36 sensitive-content marker. When set, emits
   * `["content-warning", <reason>]` (e.g. `"nsfw"`) so clients can blur/gate
   * rather than the publisher filtering the stream out.
   */
  contentWarning?: string;
  /**
   * NIP-53 `current_participants`. Emitted only when the source exposes a
   * viewer count — omitted entirely when unknown or hidden.
   */
  currentParticipants?: number;
}

/**
 * Build the tag array for a NIP-53 kind-30311 live event.
 *
 * The base tag set (with neither `relays` nor `proxy`) is byte-identical to the
 * long-standing inline construction in `stream-event.service.createLiveEvent`,
 * so existing callers are unaffected. The optional `relays` (NIP-53) and `proxy`
 * (NIP-48) tags are appended only when provided — these are the deltas the
 * standalone bridge needs.
 */
export function buildLiveEventTags(params: LiveEventTagParams): string[][] {
  const {
    dTag,
    metadata,
    streamingUrl,
    hostPubkey,
    status,
    startsTimestamp,
    relays,
    proxy,
    contentWarning,
    currentParticipants,
  } = params;

  const tags: string[][] = [
    ['d', dTag],
    ['title', metadata.title],
    ['summary', metadata.summary],
    ['image', metadata.image],
    ['streaming', streamingUrl],
    ['status', status],
    ['starts', startsTimestamp.toString()],
    ['p', hostPubkey, '', 'host'],
  ];

  if (metadata.tags && metadata.tags.length > 0) {
    for (const tag of metadata.tags) {
      tags.push(['t', tag]);
    }
  }

  if (relays && relays.length > 0) {
    tags.push(['relays', ...relays]);
  }

  if (proxy) {
    tags.push(['proxy', proxy.url, proxy.protocol ?? 'web']);
  }

  if (contentWarning) {
    tags.push(['content-warning', contentWarning]);
  }

  if (currentParticipants !== undefined && Number.isFinite(currentParticipants)) {
    tags.push(['current_participants', String(currentParticipants)]);
  }

  return tags;
}
