/**
 * Relay configuration for the shared Nostr client stack.
 *
 * These lists serve the READ side of the bridge (profile lookups for chatter
 * names). All bridge WRITES name their target relays explicitly and never
 * consult these defaults — see src/core/relays.ts and the write-containment
 * boundary test.
 *
 * Call `initAppConfig(partial)` once at startup to override; call
 * `getAppConfig()` anywhere to read the current configuration.
 */

export interface AppConfig {
  defaultReadRelays: string[];
  defaultWriteRelays: string[];
  /**
   * Small dedicated relay set for replaceable-event lookups (profiles,
   * relay lists, follow lists). These are queried first; the remaining read
   * relays are only consulted as a fallback for keys the profile relays
   * miss. Keeps the steady drip of kind-0 batch REQs off the general read
   * relays, whose per-IP rate limiters can close heavy readers.
   */
  profileRelays: string[];
}

const DEFAULTS: AppConfig = {
  // purplepag.es is deliberately NOT here: it is a profile-specialty relay
  // that rejects any REQ without a kinds filter ("blocked: filters must
  // specify at least one kind"), so general reads (event-by-id fetches,
  // browse firehose) to it are pure waste. It lives in profileRelays below.
  defaultReadRelays: [
    'wss://nostrelites.org',
    'wss://nostr.wine',
    'wss://relay.fountain.fm',
    'wss://relay.nostr.net',
    'wss://relay.primal.net',
    'wss://nos.lol',
  ],
  defaultWriteRelays: [
    'wss://relay.nostr.net',
    'wss://relay.primal.net',
  ],
  profileRelays: [
    'wss://purplepag.es',
    'wss://relay.nostr.net',
    'wss://nos.lol',
  ],
};

let currentConfig: AppConfig = { ...DEFAULTS };

/**
 * Initialise (or re-initialise) the configuration.
 *
 * Any key present in `overrides` replaces the default. Keys that are
 * `undefined` or missing keep their default value. Calling with no
 * arguments resets to defaults.
 */
export function initAppConfig(overrides: Partial<AppConfig> = {}): void {
  currentConfig = { ...DEFAULTS };
  for (const key of Object.keys(overrides) as (keyof AppConfig)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      (currentConfig as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

export function getAppConfig(): Readonly<AppConfig> {
  return currentConfig;
}
