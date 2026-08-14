/**
 * Read-only client for the relay's GET /demand endpoint (ephemeral-relay
 * feature). The relay reports every open subscription's filter with an active
 * count; the bridge greps entries whose filter names an `#a` tag to learn
 * which rooms have real Nostr viewers — expensive Owncast websockets are only
 * opened for those. The bridge's own firehose carries no `#a`, so it never
 * shows up here.
 */

interface DemandFilter {
  kinds?: number[];
  '#a'?: unknown;
  [key: string]: unknown;
}

interface DemandItem {
  filter?: DemandFilter;
  active?: number;
  last_seen?: string;
}

/** Minimal seam so the chat bridge can be tested with a fake. */
export interface DemandSource {
  fetchDemandedATags(): Promise<Set<string>>;
}

export class DemandClient implements DemandSource {
  constructor(
    private readonly url: string,
    private readonly authToken: string | null,
    private readonly timeoutMs: number = 5_000
  ) {}

  /** Every `#a` value named by at least one currently-open subscription. */
  async fetchDemandedATags(): Promise<Set<string>> {
    const headers: Record<string, string> = {};
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    const res = await fetch(this.url, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`demand endpoint responded ${res.status}`);
    }
    const body = (await res.json()) as { demand?: DemandItem[] };
    const aTags = new Set<string>();
    for (const item of body.demand ?? []) {
      if (!item.active || item.active <= 0) continue;
      const values = item.filter?.['#a'];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === 'string') aTags.add(value);
      }
    }
    return aTags;
  }
}
