import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Deterministic per-instance key derivation for bridged Nostr identities.
 *
 * A bridged source (e.g. an Owncast instance) has no Nostr key of its own. Rather
 * than provision an env-var nsec per instance — which does not scale to runtime
 * discovery — we derive a stable private key from the instance URL and a single
 * secret. The same instance therefore always resolves to the same npub across
 * restarts and poll cycles.
 *
 * SECURITY: the secret is the only thing standing between a public instance URL
 * and its bridged private key. Keep it env-only, never commit it, and rotating it
 * re-keys every bridged identity (a deliberate, breaking operation).
 */

const encoder = new TextEncoder();

/**
 * Normalise an instance URL so trivially different spellings map to the same key:
 * scheme + host (+ non-default port) + path, lowercased, no trailing slash, no
 * query/fragment.
 */
export function normalizeInstanceUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const host = u.host.toLowerCase(); // includes non-default port
  const path = u.pathname.replace(/\/+$/, ''); // strip trailing slashes
  return `${u.protocol.toLowerCase()}//${host}${path}`;
}

/**
 * Derive the 32-byte secp256k1 private key for a bridged instance.
 *
 * `privkey = HMAC-SHA256(secret, "owncast:" + normalizedUrl)`.
 *
 * The `owncast:` domain-separation prefix leaves room for other bridge sources to
 * share one secret without key collisions.
 */
export function deriveInstancePrivKey(
  instanceUrl: string,
  secret: string,
  namespace = 'owncast'
): Uint8Array {
  if (!secret) {
    throw new Error('deriveInstancePrivKey requires a non-empty secret');
  }
  const message = `${namespace}:${normalizeInstanceUrl(instanceUrl)}`;
  return hmac(sha256, encoder.encode(secret), encoder.encode(message));
}

/**
 * Derive the bridge's own operator identity key from the same secret.
 *
 * `privkey = HMAC-SHA256(secret, "bridge-identity:self")` — a namespace no
 * instance URL can occupy, so the bridge identity can never collide with a
 * derived instance key. The bridge signs kind-30311 live events as the service
 * (NIP-53 provider pattern) while each instance's derived key remains the `p`
 * host.
 */
export function deriveBridgeIdentityKey(secret: string): Uint8Array {
  if (!secret) {
    throw new Error('deriveBridgeIdentityKey requires a non-empty secret');
  }
  return hmac(sha256, encoder.encode(secret), encoder.encode('bridge-identity:self'));
}
