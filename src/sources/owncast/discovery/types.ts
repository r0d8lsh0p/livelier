/** One tag object on a directory instance. */
export interface DirectoryTag {
  name: string;
  slug: string;
  description?: string;
  image?: string;
}

/** A single Owncast instance as returned by `GET /api/home`. */
export interface DirectoryInstance {
  id: number;
  name: string;
  description: string;
  streamTitle: string;
  url: string;
  logo: string;
  tags: DirectoryTag[];
  nsfw: boolean;
  lastSeen: string;
  streamingSince: string;
}

export interface DirectorySection {
  name: string;
  online: boolean;
  description?: string;
  instances: DirectoryInstance[];
}

export interface DirectoryHome {
  sections: DirectorySection[];
  featured?: unknown;
}

/** Result of parsing the directory feed. */
export interface ParsedDirectory {
  /** Instances in `online: true` sections — the discovery "live now" set. */
  live: DirectoryInstance[];
  /**
   * The same live set as the RAW directory objects, untouched by coercion —
   * captured verbatim into hourly observation snapshots.
   */
  rawLive: unknown[];
  /** Every valid instance across all sections (deduped by normalized url). */
  all: DirectoryInstance[];
  /** Unix ms when fetched. */
  fetchedAt: number;
  /** Fingerprint of the observed field shape; logged when it drifts. */
  schemaVersion: string;
}
