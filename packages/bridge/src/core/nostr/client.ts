import type { Event, Filter } from 'nostr-tools';
import clientService from '../../../../shared/src/nostr/services/client.service';
import type { ISigner } from '../../../../shared/src/nostr/types';

/**
 * The bridge's ONE seam to the shared Nostr client — the only file in
 * this repo allowed to import `client.service` (enforced by
 * client.boundary.test.ts).
 *
 * Why: the vendored client service has a wide app-oriented surface; the
 * bridge uses exactly these five operations. Keeping every use behind one
 * typed facade makes the write-containment wall enforceable and keeps the
 * option open to swap in a bare nostr-tools implementation later.
 */
export interface NostrClient {
  /** Stamp every subsequently-signed event with this `client` tag. */
  setClientName(name: string): void;
  createSignedEvent(
    signer: ISigner,
    kind: number,
    content: string,
    tags?: string[][]
  ): Promise<Event>;
  /** Publish to the given relays only. Resolves per-relay acceptance. */
  publishEvent(event: Event, relayUrls: string[]): Promise<Record<string, boolean>>;
  /** Long-lived subscription across the given relays. */
  subscribe(
    relayUrls: string[],
    filter: Filter | Filter[],
    handlers: { onevent?: (evt: Event) => void }
  ): { close: () => void };
  /** One-shot query: collect events until EOSE (bounded by eoseDeadlineMs). */
  query(
    relayUrls: string[],
    filter: Filter | Filter[],
    options?: { eoseDeadlineMs?: number }
  ): Promise<Event[]>;
}

export const nostrClient: NostrClient = {
  setClientName: (name) => clientService.setClientName(name),
  createSignedEvent: (signer, kind, content, tags = []) =>
    clientService.createSignedEvent(signer, kind, content, tags),
  publishEvent: (event, relayUrls) => clientService.publishEvent(event, relayUrls),
  subscribe: (relayUrls, filter, handlers) => clientService.subscribe(relayUrls, filter, handlers),
  query: async (relayUrls, filter, options = {}) => {
    const { events } = await clientService.queryWithStats(relayUrls, filter, undefined, options);
    return events;
  },
};
