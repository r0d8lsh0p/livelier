import SecureStorageService from '../../storage/secure-storage.service';
import { STORAGE_KEYS } from '../../storage/config';

/**
 * Persistent negative cache for profile fetches (the Jumble null-event
 * pattern, softened).
 *
 * The in-memory retry ledger gives every missing kind-0 a bounded ladder of
 * 6 batched attempts — but the ledger dies with the process, so every
 * restart re-ran the full ladder for every missing profile. Keys that never
 * publish a kind-0 earned 6 fresh REQs per restart forever. This module persists "exhausted the
 * retry budget" so the next session skips straight to silence.
 *
 * Deliberately NOT a permanent verdict — profiles have wrongly resolved as
 * missing before (relay outages, boot races), so:
 * - entries expire after PROFILE_MISS_TTL_MS and the ladder runs again;
 * - a profile found by ANY surface clears its entry immediately;
 * - `clearProfileMiss` is the force-refresh escape hatch — callers can
 *   always bypass the negative cache explicitly.
 */

export const PROFILE_MISS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

type PersistedMisses = Record<string, { missedAt: number }>;

const SAVE_DEBOUNCE_MS = 500;

class ProfileMissCache {
  private misses: Map<string, number> = new Map(); // pubkey -> missedAt
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Load persisted misses, dropping expired entries. Returns the pubkeys
   * that are still within TTL so the caller can seed its retry ledger.
   */
  async hydrate(now: number = Date.now()): Promise<string[]> {
    try {
      const available = await SecureStorageService.isAvailable();
      if (!available) return [];

      const json = await SecureStorageService.getItem(STORAGE_KEYS.PROFILE_MISS_CACHE);
      if (!json) return [];

      const parsed = JSON.parse(json) as PersistedMisses;
      const alive: string[] = [];
      Object.entries(parsed).forEach(([pubkey, entry]) => {
        if (entry?.missedAt && now - entry.missedAt < PROFILE_MISS_TTL_MS) {
          this.misses.set(pubkey, entry.missedAt);
          alive.push(pubkey);
        }
      });

      // Rewrite if pruning dropped anything, so expired entries don't
      // accumulate in storage.
      if (alive.length !== Object.keys(parsed).length) {
        this.scheduleSave();
      }
      return alive;
    } catch (error) {
      console.warn('ProfileMissCache: failed to hydrate:', error);
      return [];
    }
  }

  /** Record that a pubkey exhausted its retry budget this session. */
  recordMiss(pubkey: string, now: number = Date.now()): void {
    this.misses.set(pubkey, now);
    this.scheduleSave();
  }

  /** Forget a miss — the profile was found, or a force refresh was requested. */
  clearMiss(pubkey: string): void {
    if (this.misses.delete(pubkey)) {
      this.scheduleSave();
    }
  }

  hasMiss(pubkey: string, now: number = Date.now()): boolean {
    const missedAt = this.misses.get(pubkey);
    if (missedAt === undefined) return false;
    if (now - missedAt >= PROFILE_MISS_TTL_MS) {
      this.misses.delete(pubkey);
      this.scheduleSave();
      return false;
    }
    return true;
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    try {
      const available = await SecureStorageService.isAvailable();
      if (!available) return;

      const out: PersistedMisses = {};
      this.misses.forEach((missedAt, pubkey) => {
        out[pubkey] = { missedAt };
      });
      await SecureStorageService.setItem(
        STORAGE_KEYS.PROFILE_MISS_CACHE,
        JSON.stringify(out)
      );
    } catch (error) {
      console.warn('ProfileMissCache: failed to save:', error);
    }
  }

  /** Test helper: reset in-memory state and any pending save. */
  resetForTesting(): void {
    this.misses.clear();
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
  }
}

const profileMissCache = new ProfileMissCache();
export default profileMissCache;
