/**
 * THE NEEDLE FILE.
 *
 * The only module in the site package that reaches outside it, into this
 * repo's `packages/shared/` Nostr client. Everything the page borrows from shared
 * comes through here, so if that client is ever swapped (for a plain
 * nostr-tools implementation, say) the blast radius is exactly one file and
 * nothing else in the site changes.
 *
 * Rules for this file:
 *  - Nothing here may import anything that pulls in React, React Native, Expo,
 *    or the storage adapters. The Nostr READ path is clean of all of those;
 *    keep it that way.
 *  - Anything the page needs from shared gets ADDED here, never imported
 *    directly from a section module.
 */
import clientService from '../../../shared/src/nostr/services/client.service';
import { normalizeInstanceUrl as sharedNormalizeInstanceUrl } from '../../../shared/src/nostr/bridge-key';
import type { Event, Filter } from 'nostr-tools';

export type NostrEvent = Event;
export type NostrFilter = Filter;

export interface ReadResult {
  events: NostrEvent[];
  /**
   * Whether any relay actually answered. False means the question could not be
   * asked, which is NOT the same as an empty answer — see fetchEvents.
   */
  reached: boolean;
}

/**
 * Read events from an explicit relay set.
 *
 * Explicit relays are non-negotiable — the bridge's own invariant #1 is that
 * no code path ever falls back to "whatever relays the client is connected
 * to", and the site holds the same line: it reads the two bridge relays and
 * nothing else.
 *
 * Uses `queryWithStats` rather than `fetchEvents` deliberately. The shared
 * client swallows per-relay failures and returns an empty array, so a plain
 * fetch cannot tell "the relay says there is nothing" from "no relay
 * answered". Its own contract says callers must treat the latter as unknown
 * and never as absence — and on this page absence is a claim: no streams live,
 * no chat held, your channel is not bridged. `reached` is what keeps those
 * claims honest.
 */
export async function fetchEvents(
  relayUrls: string[],
  filter: NostrFilter | NostrFilter[]
): Promise<ReadResult> {
  const { events, eoseCount } = await clientService.queryWithStats(relayUrls, filter);
  return { events, reached: eoseCount > 0 };
}

/** Identifies the site in relay logs, the same way the worker tags its events. */
export function setClientName(name: string): void {
  clientService.setClientName(name);
}

/**
 * Canonical instance-URL spelling. Shared with the bridge worker, which keys
 * every derived identity off this exact output — the page's d-tag lookup is
 * only correct because it uses the same function.
 */
export function normalizeInstanceUrl(rawUrl: string): string {
  return sharedNormalizeInstanceUrl(rawUrl);
}

