/**
 * Layer-3 dedup: short-TTL content fingerprints (`displayName:content`),
 * mirroring the earlier bridge implementation's guard against echo loops that survive
 * the client-tag (L1) and bridged-pubkey (L2) layers.
 */

const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

export class FingerprintCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  static key(displayName: string, content: string): string {
    return `${displayName}:${content}`;
  }

  /** True when the fingerprint was seen within the TTL. */
  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    this.prune();
    this.entries.set(key, Date.now());
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, at] of this.entries) {
      if (now - at > this.ttlMs) this.entries.delete(key);
    }
    // Hard cap: drop oldest entries beyond the limit.
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
