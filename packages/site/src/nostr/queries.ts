import { fetchEvents, type NostrEvent } from '../seam/shared';
import { config, relayHttpUrl } from '../config';

/** First value of a tag, or undefined. */
export function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** All values of a repeated tag (`t`, `p`, …). */
export function tags(event: NostrEvent, name: string): string[] {
  // A tag can legitimately be just its name (`["t"]`), in which case there is
  // no value to return — dropping those keeps the declared string[] honest and
  // stops an undefined reaching the renderers.
  return event.tags
    .filter((t) => t[0] === name)
    .map((t) => t[1])
    .filter((value): value is string => typeof value === 'string');
}

export interface Channel {
  event: NostrEvent;
  dTag: string;
  title: string;
  summary?: string;
  image?: string;
  streaming?: string;
  status: 'live' | 'ended' | 'planned' | string;
  starts?: number;
  /** The channel's derived pubkey — read off the event, never derived here. */
  hostPubkey?: string;
  /** NIP-48 attribution: the source instance this mirrors. */
  proxyUrl?: string;
  topics: string[];
  nsfw: boolean;
}

export function toChannel(event: NostrEvent): Channel {
  const starts = tag(event, 'starts');
  return {
    event,
    dTag: tag(event, 'd') ?? '',
    title: tag(event, 'title') ?? 'Untitled stream',
    summary: tag(event, 'summary'),
    image: tag(event, 'image'),
    streaming: tag(event, 'streaming'),
    status: tag(event, 'status') ?? 'unknown',
    starts: starts ? Number(starts) : undefined,
    hostPubkey: event.tags.find((t) => t[0] === 'p')?.[1],
    proxyUrl: tag(event, 'proxy'),
    topics: tags(event, 't'),
    nsfw: event.tags.some((t) => t[0] === 'content-warning'),
  };
}

/**
 * Every live event the bridge has published. `status` is not a single-letter
 * tag, so relays don't index it — the split between live and ended is done
 * here, over the full set. That set is small by construction (one addressable
 * event per bridged channel).
 */
export async function fetchChannels(limit = 500): Promise<{ channels: Channel[]; reached: boolean }> {
  const { events, reached } = await fetchEvents([config.eventRelay], { kinds: [30311], limit });
  return { channels: events.map(toChannel), reached };
}

/** Channel kind-0s live on the chat relay; returns pubkey → parsed profile content. */
export async function fetchChannelProfiles(
  pubkeys: string[]
): Promise<Map<string, ChannelProfile>> {
  const result = new Map<string, ChannelProfile>();
  if (pubkeys.length === 0) return result;

  const { events } = await fetchEvents([config.chatRelay], {
    kinds: [0],
    authors: pubkeys,
    limit: pubkeys.length,
  });

  for (const event of events) {
    const profile = parseProfile(event);
    if (!profile) continue;
    const existing = result.get(event.pubkey);
    // Replaceable: newest wins.
    if (!existing || existing.createdAt < event.created_at) {
      result.set(event.pubkey, profile);
    }
  }
  return result;
}

export interface ChannelProfile {
  name?: string;
  about?: string;
  picture?: string;
  website?: string;
  createdAt: number;
}

function parseProfile(event: NostrEvent): ChannelProfile | null {
  try {
    const parsed = JSON.parse(event.content) as Record<string, unknown>;
    return {
      name: str(parsed.display_name) ?? str(parsed.name),
      about: str(parsed.about),
      picture: str(parsed.picture),
      website: str(parsed.website),
      createdAt: event.created_at,
    };
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * How many creators the bridge has an identity for, counted off the `kind:0`
 * profiles on the chat relay — the identity record, one per bridged channel.
 *
 * `exclude` carries the bridge's own key, which also has a profile there.
 * Note that ephemeral chatter identities publish `kind:0` to this relay too,
 * so this leans slightly high; counting distinct hosts off the live events
 * instead would be exact.
 */
export async function fetchCreatorCount(exclude: Set<string>): Promise<number | null> {
  const { events, reached } = await fetchEvents([config.chatRelay], { kinds: [0], limit: 1000 });
  if (!reached) return null;
  const authors = new Set(
    events.map((event) => event.pubkey).filter((pubkey) => !exclude.has(pubkey))
  );
  return authors.size;
}

/**
 * Bridged chat currently held on the chat relay. The number is interesting
 * precisely because of its ceiling: the relay hard-deletes these after its
 * stated TTL, so this can only ever be the last few hours of traffic.
 */
export async function fetchChatMessages(
  limit = 500
): Promise<{ events: NostrEvent[]; reached: boolean }> {
  return fetchEvents([config.chatRelay], { kinds: [1311], limit });
}

/**
 * Only the messages the bridge itself created.
 *
 * The chat relay also holds messages posted straight to it by Nostr clients —
 * a viewer in the Shosho app, say — which the bridge carries INTO the source
 * chat but did not sign. Those carry no NIP-70 marker and no NIP-40 expiry,
 * because the bridge only attaches those to what it mirrors outward. Showing
 * one as an example of bridged chat would be presenting someone else's event
 * as our work, and would display the guarantees as absent.
 */
export function bridgeAuthored(events: NostrEvent[]): NostrEvent[] {
  return events.filter((event) => tag(event, 'client') === config.bridgeName);
}

/** One chat author's profile. Bridged chatters exist only on the chat relay. */
export async function fetchProfile(pubkey: string): Promise<ChannelProfile | undefined> {
  return (await fetchChannelProfiles([pubkey])).get(pubkey);
}

/** The NIP-53 room coordinate a stream's chat messages are tagged with. */
export function roomCoordinate(channel: Channel): string {
  return `30311:${channel.event.pubkey}:${channel.dTag}`;
}

/**
 * Bridged chat messages currently tagged to one stream's room.
 *
 * Deliberately fetched WITHOUT an `#a` filter and matched here instead. The
 * chat relay's `/demand` endpoint counts `#a`-scoped subscriptions as viewer
 * demand, and the bridge opens a source-side chat connection when demand
 * appears — so a filtered REQ from this page would make looking a channel up
 * on the website indistinguishable from someone actually watching it. The
 * whole set is small and short-lived, so scanning it costs nothing.
 */
export async function fetchRoomChatCount(coordinate: string): Promise<number | null> {
  const { events, reached } = await fetchEvents([config.chatRelay], { kinds: [1311], limit: 500 });
  if (!reached) return null;
  return bridgeAuthored(events).filter((event) => tags(event, 'a').includes(coordinate)).length;
}

/** A single channel's live event, by d-tag. */
export async function fetchChannelByDTag(
  dTag: string
): Promise<{ channel: Channel | null; reached: boolean }> {
  const { events, reached } = await fetchEvents([config.eventRelay], {
    kinds: [30311],
    '#d': [dTag],
    limit: 1,
  });
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
  return { channel: newest ? toChannel(newest) : null, reached };
}

export interface RelayInfo {
  name?: string;
  description?: string;
  software?: string;
  version?: string;
  supported_nips?: number[];
}

/**
 * The relay's own NIP-11 document. Both bridge relays serve it with
 * `Access-Control-Allow-Origin: *`, so the retention policy shown on this page
 * is quoted from the machine that enforces it rather than written by us.
 */
export async function fetchRelayInfo(wssUrl: string): Promise<RelayInfo | null> {
  try {
    const response = await fetch(relayHttpUrl(wssUrl), {
      headers: { Accept: 'application/nostr+json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as RelayInfo;
  } catch {
    return null;
  }
}
