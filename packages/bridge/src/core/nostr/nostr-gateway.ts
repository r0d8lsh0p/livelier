import type { Event, Filter } from 'nostr-tools';
import { DerivedKeySigner } from '../../../../shared/src/nostr/signers/derived-key.signer';
// READ-ONLY use of the shared profile stack (coordinator: batching, in-flight
// dedup, retry ledger, its own relay coverage). Reads are unconstrained — the
// bridge's containment invariant is about WRITES, which all name their target
// relays explicitly (see client.boundary.test.ts).
import profileService from '../../../../shared/src/nostr/services/profile.service';
import { nostrClient } from './client';
import { publishAuthed } from './authed-publish';

/** Chat-room event kinds mirrored from zap.stream's chat REQ. Only 1311 is
 * delivered into the source chat today; 1312/1313 ride along for future use. */
export const CHAT_EVENT_KINDS: readonly number[] = Object.freeze([1311, 1312, 1313]);

/**
 * The chat bridge's single seam to the Nostr network. Every method is pinned to
 * the ONE local relay passed at construction — the relay-exclusivity
 * invariant holds here by construction, and tests can inject a fake.
 */
export interface NostrGateway {
  publish(signer: DerivedKeySigner, kind: number, content: string, tags: string[][]): Promise<void>;
  /**
   * Best-effort plain publish to an explicit relay list (no NIP-42) — for
   * profile-class events (kind 0/10002) that also go to network profile
   * relays when the flag is on. Never throws on relay rejection.
   */
  broadcast(
    signer: DerivedKeySigner,
    kind: number,
    content: string,
    tags: string[][],
    relayUrls: string[]
  ): Promise<void>;
  /**
   * Wide chat-kind firehose on NETWORK relays — deliberately NOT #a-scoped:
   * a coordinate list would hit relay filter-size caps as the fleet grows
   * and need resubscribing on every live-set change, both silent-failure
   * modes. Network 1311 volume is small; room routing happens internally
   * off each event's `a` tag, exactly like the local firehose.
   */
  subscribeNetworkChat(
    relayUrls: string[],
    onevent: (event: Event) => void,
    onclose?: (reasons: string[]) => void
  ): { close: () => void };
  /**
   * Full kind-1311 firehose from the local relay. Deliberately carries no `#a`
   * filter: the relay's /demand endpoint counts open `#a`-scoped subscriptions
   * as viewer demand, and the bridge's own reader must never register as a
   * viewer. Room routing happens client-side off each event's `a` tag.
   *
   * `onclose` is not optional in practice: the client re-opens a REQ only
   * after a rate-limit close, so a consumer that ignores it loses the
   * firehose for the life of the process on every other close reason.
   */
  subscribe1311(
    onevent: (event: Event) => void,
    onclose?: (reasons: string[]) => void
  ): { close: () => void };
  fetchProfileName(pubkey: string): Promise<string | null>;
}

export class ClientServiceGateway implements NostrGateway {
  constructor(private readonly relayUrl: string) {}

  async publish(
    signer: DerivedKeySigner,
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<void> {
    // createSignedEvent stamps the bridge's client tag (L1 dedup relies on
    // it); the one-shot authed publish satisfies the relay's NIP-70 policy
    // for '-'-tagged events by NIP-42-authing as the event's author, and
    // throws on rejection so failures can't masquerade as bridged messages.
    const event = await nostrClient.createSignedEvent(signer, kind, content, tags);
    await publishAuthed(this.relayUrl, signer, event);
  }

  async broadcast(
    signer: DerivedKeySigner,
    kind: number,
    content: string,
    tags: string[][],
    relayUrls: string[]
  ): Promise<void> {
    const event = await nostrClient.createSignedEvent(signer, kind, content, tags);
    await nostrClient.publishEvent(event, relayUrls);
  }

  subscribeNetworkChat(
    relayUrls: string[],
    onevent: (event: Event) => void,
    onclose?: (reasons: string[]) => void
  ): { close: () => void } {
    const filter: Filter = {
      kinds: [...CHAT_EVENT_KINDS],
      since: Math.floor(Date.now() / 1000),
    };
    return nostrClient.subscribe(relayUrls, filter, { onevent, onclose });
  }

  subscribe1311(
    onevent: (event: Event) => void,
    onclose?: (reasons: string[]) => void
  ): { close: () => void } {
    const filter: Filter = {
      kinds: [1311],
      since: Math.floor(Date.now() / 1000),
    };
    return nostrClient.subscribe([this.relayUrl], filter, { onevent, onclose });
  }

  async fetchProfileName(pubkey: string): Promise<string | null> {
    // Both sources race in parallel: the shared coordinator covers the
    // network (canonical identities), the direct query covers our own chat
    // relay (identities that only exist there — e.g. viewers who published
    // straight to us). Network wins when both answer.
    const [network, local] = await Promise.all([
      profileService.getProfile(pubkey).catch(() => null),
      this.fetchLocalProfileName(pubkey),
    ]);
    return network?.name || local;
  }

  private async fetchLocalProfileName(pubkey: string): Promise<string | null> {
    const events = await nostrClient.query(
      [this.relayUrl],
      { kinds: [0], authors: [pubkey], limit: 1 },
      { eoseDeadlineMs: 3000 }
    );
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) return null;
    try {
      const profile = JSON.parse(newest.content) as { display_name?: string; name?: string };
      return profile.display_name || profile.name || null;
    } catch {
      return null;
    }
  }
}
