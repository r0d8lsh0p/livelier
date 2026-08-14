import { normalizeInstanceUrl } from '../seam/shared';

/**
 * Recompute a bridged instance's `d` tag in the browser.
 *
 * The worker's `dTagFor()` is `<prefix>-<first 16 hex of sha256(normalizedUrl)>`
 * (src/core/identity.ts). It runs on Node's crypto; this is the
 * same function over WebCrypto, and it MUST stay byte-identical — a streamer
 * looking themselves up gets nothing at all if these two ever drift.
 *
 * Note what is deliberately absent: the npub. Deriving that needs
 * BRIDGE_KEY_SECRET, which is not in this bundle and never will be. The page
 * reads a channel's key off the `p` tag of an event the relay already serves to
 * anyone — the same way any other Nostr client would.
 */
export async function dTagFor(instanceUrl: string, prefix: string): Promise<string> {
  const normalized = normalizeInstanceUrl(instanceUrl);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hex.slice(0, 16)}`;
}

/**
 * Accept what a streamer would actually paste — `example.com`, `example.com/`,
 * `https://example.com/chat` — and hand back something `new URL()` will take.
 * Returns null when there is no sane reading, so the caller can say so.
 */
export function coerceInstanceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}
