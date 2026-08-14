import { nip19 } from 'nostr-tools';
import { config } from '../config';
import type { NostrEvent } from '../seam/shared';

/**
 * Links out to njump, a third-party renderer — someone else's view of the same
 * event.
 *
 * Both forms carry a relay hint, which is not optional here: these events live
 * only on Livelier's relays by design, so a reader has nowhere else to find
 * them.
 */

/**
 * Live events are addressable (kind 30311), so the identifier is the
 * coordinate — kind, author, d-tag — not the id of one particular version.
 * That keeps the link pointing at the current state of the stream rather than
 * at whichever revision happened to be on screen.
 */
export function njumpAddress(event: NostrEvent, identifier: string): string {
  try {
    return (
      config.njump +
      nip19.naddrEncode({
        identifier,
        pubkey: event.pubkey,
        kind: event.kind,
        relays: [config.eventRelay],
      })
    );
  } catch {
    return config.njump + event.id;
  }
}

/** Chat messages are regular events, so they are addressed by id. */
export function njumpEvent(event: NostrEvent, relay: string): string {
  try {
    return (
      config.njump +
      nip19.neventEncode({
        id: event.id,
        author: event.pubkey,
        kind: event.kind,
        relays: [relay],
      })
    );
  } catch {
    return config.njump + event.id;
  }
}
