import crypto from 'crypto';
import { nip19 } from 'nostr-tools';
import {
  deriveBridgeIdentityKey,
  deriveInstancePrivKey,
  normalizeInstanceUrl,
} from '../../../shared/src/nostr/bridge-key';
import { DerivedKeySigner } from '../../../shared/src/nostr/signers/derived-key.signer';

/**
 * Resolve the bridge identity signer: an explicit BRIDGE_NSEC when provided,
 * else deterministically derived from BRIDGE_KEY_SECRET.
 */
export function bridgeSignerFrom(config: {
  bridgeNsec: string | null;
  bridgeKeySecret: string;
}): DerivedKeySigner {
  if (config.bridgeNsec) {
    const { type, data } = nip19.decode(config.bridgeNsec);
    if (type !== 'nsec') {
      throw new Error('BRIDGE_NSEC is not a valid nsec');
    }
    return new DerivedKeySigner(data);
  }
  return new DerivedKeySigner(deriveBridgeIdentityKey(config.bridgeKeySecret));
}

/**
 * Per-instance signer, keyed to the normalized URL and namespaced by source so
 * two networks can never collide on one derived key.
 */
export function instanceSigner(
  instanceUrl: string,
  secret: string,
  sourceKey: string
): DerivedKeySigner {
  return new DerivedKeySigner(deriveInstancePrivKey(instanceUrl, secret, sourceKey));
}

/**
 * Per-instance d-tag. The 30311 author is the single bridge identity, so the
 * addressable coordinate `30311:<bridgePubkey>:<d>` must be unique per instance —
 * a shared d-tag would make every instance's event replace the others.
 *
 * Kept under 30 characters: relays running nostrlib's LMDB backend truncate
 * the d-tag portion of their `#a` index at 30 bytes and then fail to match
 * queries, which silently breaks client chat lookups for longer coordinates.
 * 16 hex chars of the URL hash (64 bits) keeps collisions out of the picture.
 */
export function dTagFor(instanceUrl: string, prefix: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(normalizeInstanceUrl(instanceUrl))
    .digest('hex')
    .slice(0, 16);
  return `${prefix}-${hash}`;
}

/** Short content hash gating kind-0 republishes to actual profile changes. */
export function profileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
