import { ISigner } from '../types';
import { EventTemplate, Event, getPublicKey, finalizeEvent } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';

/**
 * A signer backed by a raw 32-byte private key supplied at construction time.
 *
 * Unlike {@link NsecSigner}, this is not "logged in" from stored user state — the
 * caller provides the key directly. The standalone Owncast bridge uses this with a
 * per-instance key deterministically derived from the instance URL (see
 * `bridge-key.ts`), so every discovered channel maps to a stable npub across
 * restarts without provisioning an env-var nsec per instance.
 */
export class DerivedKeySigner implements ISigner {
  private readonly privkey: Uint8Array;
  private readonly pubkey: string;

  constructor(privkey: Uint8Array | string) {
    const bytes = typeof privkey === 'string' ? hexToBytes(privkey) : privkey;
    if (bytes.length !== 32) {
      throw new Error(`DerivedKeySigner requires a 32-byte private key, got ${bytes.length}`);
    }
    this.privkey = bytes;
    this.pubkey = getPublicKey(this.privkey);
  }

  getPublicKey(): string {
    return this.pubkey;
  }

  signEvent(event: EventTemplate): Event {
    return finalizeEvent(event, this.privkey);
  }

}
