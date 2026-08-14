import { ProfileInfo } from '../nostr/services/profile.service';
import SecureStorageService from '../storage/secure-storage.service';
import { STORAGE_KEYS } from '../storage/config';

/**
 * ProfileCacheService - A cache for Nostr profiles with persistent storage
 *
 * Deliberately a single shared singleton: profiles cached by one consumer
 * must be visible to the others, and two instances persisting whole-map
 * snapshots to the same storage key would clobber each other.
 *
 * This service stores successfully fetched profiles to prevent showing "Loading..."
 * for messages from users whose profiles have already been fetched.
 */
class ProfileCacheService {
  private cache: Map<string, ProfileInfo> = new Map();
  private initialized: boolean = false;
  private initPromise: Promise<void>;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // TTL for cache entries (30 days)
  private readonly CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

  // Maximum number of profiles to store in the cache
  private readonly MAX_CACHE_SIZE = 500;

  // Debounce window for save operations (ms)
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor() {
    // Initialize the cache from storage
    this.initPromise = this.loadFromStorage().catch(err => {
      console.error('ProfileCacheService: ⚠️ Error loading from storage:', err);
    });
  }

  /**
   * Resolves once the persisted cache has loaded (or failed to). Fetch
   * coordination awaits this before its first relay dispatch — the cache is
   * checked synchronously, so consulting it before hydration finished made
   * every boot refetch profiles that were already on disk.
   */
  whenInitialized(): Promise<void> {
    return this.initPromise;
  }

  /**
   * Load profiles from storage
   */
  private async loadFromStorage(): Promise<void> {
    try {
      // Check if storage is available
      const isAvailable = await SecureStorageService.isAvailable();
      
      if (!isAvailable) {
        this.initialized = true;
        return;
      }
      
      // Load profiles from storage
      const profilesJson = await SecureStorageService.getItem(STORAGE_KEYS.PROFILE_CACHE);
      
      if (profilesJson) {
        try {
          const profiles = JSON.parse(profilesJson);
          const now = Date.now();
          
          // Populate the cache with non-expired profiles
          for (const pubkey in profiles) {
            if (profiles.hasOwnProperty(pubkey)) {
              const profile = profiles[pubkey] as ProfileInfo;
              // Check if the profile has expired
              if (profile.timestamp && now - profile.timestamp < this.CACHE_TTL) {
                this.cache.set(pubkey, profile);
              }
            }
          }
          
        } catch (e) {
          console.error('ProfileCacheService: ⚠️ Error parsing profiles from storage:', e);
        }
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('ProfileCacheService: ⚠️ Error loading from storage:', error);
      this.initialized = true;
    }
  }

  /**
   * Save profiles to storage
   */
  private async saveToStorage(): Promise<void> {
    try {
      const isAvailable = await SecureStorageService.isAvailable();
      if (!isAvailable) {
        return;
      }

      const profiles: Record<string, ProfileInfo> = {};
      this.cache.forEach((profile, pubkey) => {
        profiles[pubkey] = profile;
      });

      await SecureStorageService.setItem(
        STORAGE_KEYS.PROFILE_CACHE,
        JSON.stringify(profiles)
      );
    } catch (error) {
      console.error('ProfileCacheService: Error saving to storage:', error);
    }
  }

  /**
   * Schedule a debounced save to storage.
   * Rapid successive calls reset the timer so only one write occurs after
   * the batch settles. The in-memory cache is always up-to-date immediately.
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.saveToStorage().catch(err => {
        console.error('ProfileCacheService: ⚠️ Error saving to storage:', err);
      });
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Enforce the maximum cache size by removing the least recently accessed profiles
   */
  private enforceCacheLimit(): void {
    if (this.cache.size <= this.MAX_CACHE_SIZE) {
      return;
    }
    
    // Convert to array for sorting
    const profiles = Array.from(this.cache.entries());
    
    // Sort by lastAccessed (oldest first)
    profiles.sort((a, b) => {
      const aTime = a[1].lastAccessed || a[1].timestamp || 0;
      const bTime = b[1].lastAccessed || b[1].timestamp || 0;
      return aTime - bTime;
    });
    
    // Remove oldest profiles until we're under the limit
    const toRemove = profiles.slice(0, profiles.length - this.MAX_CACHE_SIZE);
    toRemove.forEach(([pubkey]) => {
      this.cache.delete(pubkey);
    });
    
  }

  /**
   * Get a profile from the cache
   * @param pubkey The pubkey to get the profile for
   * @returns The profile or null if not in cache
   */
  getProfile(pubkey: string): ProfileInfo | null {
    // If not initialized yet, return null
    if (!this.initialized) {
      return null;
    }
    
    const profile = this.cache.get(pubkey);
    if (!profile) {
      return null;
    }
    
    // Check if the profile has expired
    const now = Date.now();
    if (profile.timestamp && now - profile.timestamp > this.CACHE_TTL) {
      // Profile has expired, remove it from cache
      this.cache.delete(pubkey);
      return null;
    }
    
    // Update access metadata
    profile.lastAccessed = now;
    profile.accessCount = (profile.accessCount || 0) + 1;
    this.cache.set(pubkey, profile);
    
    return profile;
  }

  /**
   * Store a profile in the cache
   * @param pubkey The pubkey to store the profile for
   * @param profile The profile to store
   */
  storeProfile(pubkey: string, profile: ProfileInfo): void {
    const now = Date.now();
    const updatedProfile = {
      ...profile,
      timestamp: profile.timestamp || now,
      lastUpdated: now,
      lastAccessed: now,
      accessCount: 1
    };

    this.cache.set(pubkey, updatedProfile);
    
    // Enforce cache size limit
    this.enforceCacheLimit();

    // Schedule a debounced save so rapid successive stores coalesce into one write
    this.scheduleSave();
  }

  /**
   * Check if a profile exists in the cache
   * @param pubkey The pubkey to check
   * @returns True if the profile exists in the cache
   */
  hasProfile(pubkey: string): boolean {
    // If not initialized yet, return false
    if (!this.initialized) {
      return false;
    }
    
    if (!this.cache.has(pubkey)) {
      return false;
    }
    
    // Check if the profile has expired
    const profile = this.cache.get(pubkey)!;
    const now = Date.now();
    if (profile.timestamp && now - profile.timestamp > this.CACHE_TTL) {
      // Profile has expired, remove it from cache
      this.cache.delete(pubkey);
      return false;
    }
    
    return true;
  }

  /**
   * Get all non-expired cached profiles as `{ pubkey, profile }` entries.
   * Matches over already-seen
   * profiles without hitting the network. Does not update access metadata.
   */
  getAllProfiles(): Array<{ pubkey: string; profile: ProfileInfo }> {
    if (!this.initialized) {
      return [];
    }

    const now = Date.now();
    const entries: Array<{ pubkey: string; profile: ProfileInfo }> = [];
    this.cache.forEach((profile, pubkey) => {
      if (profile.timestamp && now - profile.timestamp > this.CACHE_TTL) {
        return;
      }
      entries.push({ pubkey, profile });
    });
    return entries;
  }

  /**
   * Remove a single profile from the cache
   */
  removeProfile(pubkey: string): void {
    if (!this.initialized) {
      return;
    }

    const existed = this.cache.delete(pubkey);
    if (!existed) {
      return;
    }

    this.saveToStorage().catch(err => {
      console.error('ProfileCacheService: ⚠️ Error saving to storage after removal:', err);
    });
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    
    // Clear from storage (async, but we don't wait for it)
    SecureStorageService.deleteItem(STORAGE_KEYS.PROFILE_CACHE).catch(err => {
      console.error('ProfileCacheService: ⚠️ Error clearing profiles from storage:', err);
    });
  }
}

// Export a singleton instance
const profileCacheService = new ProfileCacheService();
export default profileCacheService;
