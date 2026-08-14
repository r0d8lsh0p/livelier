import profileRequestCoordinator from './profile-request-coordinator';

/**
 * Type for profile information
 */
export type ProfileInfo = {
  name: string;
  picture: string | null;
  timestamp: number;
  // Optional metadata
  lastUpdated?: number;
  lastAccessed?: number;
  accessCount?: number;
  // Additional profile fields
  about?: string;
  nip05?: string;
  banner?: string;
  website?: string;
  lud16?: string; // Lightning address
};

/**
 * ProfileService - Service for fetching and managing Nostr profiles.
 *
 * Read paths (`getProfile` / `getProfiles`) delegate to the shared
 * profileRequestCoordinator singleton, which owns all fetch coordination:
 * cache-first partitioning, in-flight dedup across every caller, the bounded
 * exponential-backoff retry ledger, and a single retry heartbeat. Keeping that
 * state in one place is what prevents the per-caller REQ fan-out that
 * previously tripped relay "too many concurrent REQs" limits.
 */
class ProfileService {
  /**
   * Get a profile by pubkey. Cache-first, deduped and retried by the shared
   * coordinator. Resolves to the profile, or null if not (yet) known.
   */
  async getProfile(pubkey: string): Promise<ProfileInfo | null> {
    return profileRequestCoordinator.getProfile(pubkey);
  }

  /**
   * Get multiple profiles at once. One coalesced, deduped batch through the
   * shared coordinator.
   * @param pubkeys Array of pubkeys to get profiles for
   * @returns Promise that resolves to a map of pubkey -> profile (or null)
   */
  async getProfiles(pubkeys: string[]): Promise<Record<string, ProfileInfo | null>> {
    return profileRequestCoordinator.getProfiles(pubkeys);
  }
}

// Export a singleton instance
const profileService = new ProfileService();
export default profileService;
