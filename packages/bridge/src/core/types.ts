/** A persisted bridge instance row (any source network). */
export interface InstanceRow {
  url: string;
  /** Source network key ('owncast', …). */
  source: string;
  /** Provenance: 'discovered' from the source's live feed, or 'manual'. */
  origin: string;
  pubkey: string;
  d_tag: string;
  name: string;
  stream_title: string;
  description: string;
  image: string;
  nsfw: boolean;
  starts_at: Date | null;
  status: 'live' | 'ended';
  hls_url: string;
  last_liveness: string | null;
  consecutive_failures: number;
  profile_hash: string | null;
  /** Last PUBLISHED viewer count; null when the source hides it. */
  viewer_count: number | null;
  chat_enabled: boolean;
  /**
   * False = the poller stops touching this instance: no publishes, no
   * probes. Already-published events stay on the relays (removal is a
   * manual operator action). The row itself stays too — otherwise
   * rediscovery would treat the instance as new and re-publish it.
   */
  discovery_enabled: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  last_published_at: Date | null;
  updated_at: Date;
}
