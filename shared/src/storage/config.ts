/**
 * Storage keys for the persistent caches.
 */
export const STORAGE_KEYS = {
  // Profile cache
  PROFILE_CACHE: 'livelier_profile_cache',

  // Profiles whose kind-0 fetch exhausted its retry budget (negative cache)
  PROFILE_MISS_CACHE: 'livelier_profile_miss_cache',
};
