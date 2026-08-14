import { Event } from 'nostr-tools';
import { getAppConfig } from '../config/app-config';

/**
 * Default relay getters. The lists live in AppConfig (see
 * config/app-config.ts) and serve the READ side only; every write names
 * its relays explicitly. purplepag.es is profile-specialty: it belongs in
 * profileRelays and must never join the general read set (it rejects REQs
 * without a kinds filter).
 */
export function getDefaultReadRelays(): readonly string[] {
  return getAppConfig().defaultReadRelays;
}

export function getDefaultWriteRelays(): readonly string[] {
  return getAppConfig().defaultWriteRelays;
}

/**
 * Dedicated relays for replaceable-event lookups (kind 0/3/10002 …).
 * purplepag.es is a profile-specialty relay with broad kind-0 coverage.
 * See `AppConfig.profileRelays`.
 */
export function getProfileRelays(): readonly string[] {
  return getAppConfig().profileRelays;
}




/**
 * Interface for a complete relay list
 */
export interface RelayList {
  read: string[];
  write: string[];
}



/** True when the URL already carries a websocket scheme. */
function isWebsocketUrl(url: string): boolean {
  return url.startsWith('wss://') || url.startsWith('ws://');
}

/**
 * Normalize a relay URL to ensure consistent format
 * @param url The URL to normalize
 * @returns The normalized URL or null if invalid
 */
export function normalizeUrl(url: string): string | null {
  try {
    // Ensure URL starts with wss:// or ws://
    if (!isWebsocketUrl(url)) {
      url = 'wss://' + url;
    }
    
    // Remove trailing slashes
    url = url.replace(/\/+$/, '');
    
    // Validate URL format
    new URL(url);
    
    return url;
  } catch (error) {
    console.error('Error normalizing URL:', error);
    return null;
  }
}



/**
 * Extract relay list information from a relay list event (kind 10002)
 *
 * IMPORTANT: This function returns the user's relays DISCRETELY - no defaults are mixed in.
 * If the user has no relay list event or empty arrays, that's what gets returned.
 * Callers who need defaults for operations should merge them separately.
 *
 * @param event The relay list event
 * @returns The extracted relay list information, or null if no event provided
 */
export function getRelayListFromRelayListEvent(event?: Event): RelayList | null {
  if (!event) {
    return null;
  }

  const relayList = {
    write: [] as string[],
    read: [] as string[]
  };

  // Filter for 'r' tags and process each one
  event.tags.filter(tag => tag[0] === 'r').forEach(([, url, type]) => {
    if (!url || !isWebsocketUrl(url)) return;

    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) return;

    switch (type) {
      case 'write':
        relayList.write.push(normalizedUrl);
        break;
      case 'read':
        relayList.read.push(normalizedUrl);
        break;
      default:
        relayList.write.push(normalizedUrl);
        relayList.read.push(normalizedUrl);
    }
  });

  return relayList;
}


