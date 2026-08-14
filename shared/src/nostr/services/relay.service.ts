import { RelayList, getDefaultReadRelays, getDefaultWriteRelays, getProfileRelays } from '../relay-utils';

/**
 * Service for managing relay selection based on user preferences
 */
export class RelayService {
  private lastReadSource: string | null = null;
  private lastWriteSource: string | null = null;

  private shouldMergeDefaults(): boolean {
    return !(process.env.NOSTR_RELAYS_DISABLE_DEFAULTS === 'true' || process.env.NOSTR_RELAYS_DISABLE_DEFAULTS === '1');
  }

  /**
   * Get relays for read operations
   * Combines user's read relays with default relays to ensure essential relays are included
   *
   * @param userRelays The user's relay preferences (optional, overrides context retriever)
   * @returns Array of relay URLs for read operations
   */
  getReadRelays(userRelays?: RelayList | null): string[] {
    // If explicit userRelays are provided, use them
    if (userRelays?.read && userRelays.read.length > 0) {
      // Merge user relays with defaults to ensure essential relays are included
      if (!this.shouldMergeDefaults()) {
        this.logReadSourceChange('explicit', userRelays.read);
        return userRelays.read;
      }
      const mergedRelays = [...new Set([...userRelays.read, ...getDefaultReadRelays()])];
      this.logReadSourceChange('explicit+defaults', mergedRelays);
      return mergedRelays;
    }


    // Fall back to defaults if no relays are available
    this.logReadSourceChange('defaults', [...getDefaultReadRelays()]);
    return [...getDefaultReadRelays()];
  }

  /**
   * Get relays for write operations
   * Uses user's write relays if available, otherwise falls back to defaults
   *
   * @param userRelays The user's relay preferences (optional, overrides context retriever)
   * @returns Array of relay URLs for write operations
   */
  getWriteRelays(userRelays?: RelayList | null): string[] {
    // If explicit userRelays are provided, use them
    if (userRelays?.write && userRelays.write.length > 0) {
      this.logWriteSourceChange('explicit', userRelays.write);
      return userRelays.write;
    }


    // Fall back to defaults if no relays are available
    this.logWriteSourceChange('defaults', [...getDefaultWriteRelays()]);
    return [...getDefaultWriteRelays()];
  }

  /** Log read relay source only when it changes */
  private logReadSourceChange(source: string, relays: string[]): void {
    if (this.lastReadSource !== source) {
      this.lastReadSource = source;
      console.log(`RelayService: Read relays [${source}] (${relays.length}): ${relays.join(', ')}`);
    }
  }

  /** Log write relay source only when it changes */
  private logWriteSourceChange(source: string, relays: string[]): void {
    if (this.lastWriteSource !== source) {
      this.lastWriteSource = source;
      console.log(`RelayService: Write relays [${source}] (${relays.length}): ${relays.join(', ')}`);
    }
  }

  /**
   * Dedicated relays for replaceable-event lookups (profiles, relay lists,
   * follow lists). Deliberately NOT merged with the read relay set — the
   * point is to keep the steady drip of small kind-0 batch REQs off the
   * general read relays. Use `getProfileFallbackRelays()` for the remainder.
   */
  getProfileRelays(): string[] {
    return [...getProfileRelays()];
  }

  /**
   * Read relays NOT in the profile relay set — the second-tier ask for
   * profile keys the dedicated relays missed, so a profile that lives only
   * on a user-configured relay still resolves before a miss is recorded.
   */
  getProfileFallbackRelays(userRelays?: RelayList | null): string[] {
    const profileRelays = new Set(getProfileRelays());
    return this.getReadRelays(userRelays ?? null).filter((url) => !profileRelays.has(url));
  }

}

// Export a singleton instance
const relayService = new RelayService();
export default relayService;
