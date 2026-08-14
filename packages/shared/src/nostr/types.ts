import type { Event, EventTemplate } from 'nostr-tools';

/**
 * Interface for Nostr signers
 */
export interface ISigner {
  /**
   * Get the public key associated with this signer
   */
  getPublicKey(): Promise<string> | string;

  /**
   * Sign an event
   * @param event The event to sign
   */
  signEvent(event: EventTemplate): Promise<Event> | Event;

}
