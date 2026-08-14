import type { ProfileInfo } from '../services/profile.service';

/**
 * Parse a kind-0 Nostr event's `content` field into a ProfileInfo.
 *
 * This is the single source of truth for converting raw kind-0 JSON into the
 * profile shape used by the profile read stack.
 */
export function parseKind0Content(content: string): ProfileInfo | null {
  try {
    const c = JSON.parse(content);
    return {
      name: c.name || c.display_name || 'Guest',
      picture: c.picture || null,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 1,
      about: c.about || undefined,
      nip05: c.nip05 || undefined,
      banner: c.banner || undefined,
      website: c.website || undefined,
      lud16: c.lud16 || undefined,
    };
  } catch {
    return null;
  }
}
