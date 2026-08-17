import { nip19 } from 'nostr-tools';

/**
 * Options for truncating Nostr keys
 */
interface TruncateNostrKeyOptions {
  /**
   * Number of characters to show at the beginning of the key
   * @default 6
   */
  prefixLength?: number;
  
  /**
   * Number of characters to show at the end of the key
   * @default 4
   */
  suffixLength?: number;
  
  /**
   * Separator to use between prefix and suffix
   * @default "..."
   */
  separator?: string;
  
  /**
   * Whether to add "npub" prefix to the truncated key
   * Only applies when the input is a raw pubkey (not an npub)
   * @default false
   */
  addNpubPrefix?: boolean;
}

/**
 * Options for abridging bech32 IDs
 */
interface AbridgeBech32Options {
  /**
   * Number of characters to show at the beginning of the ID
   * @default 8
   */
  prefixLength?: number;

  /**
   * Number of characters to show at the end of the ID
   * @default 4
   */
  suffixLength?: number;

  /**
   * Separator to use between prefix and suffix
   * @default "..."
   */
  separator?: string;
}

/**
 * Truncates a Nostr key (pubkey or npub) for display
 * 
 * @param key The Nostr key to truncate (pubkey or npub)
 * @param options Truncation options
 * @returns Truncated key string
 * 
 * @example
 * // Truncate a pubkey
 * truncateNostrKey('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
 * // Returns: "123456...abcd"
 * 
 * @example
 * // Truncate an npub
 * truncateNostrKey('npub1abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345')
 * // Returns: "npub1ab...1234"
 * 
 * @example
 * // Truncate a pubkey and add npub prefix
 * truncateNostrKey('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', { addNpubPrefix: true })
 * // Returns: "npub123456...abcd"
 */
export function truncateNostrKey(key: string, options: TruncateNostrKeyOptions = {}): string {
  // If key is empty or too short, return as is
  if (!key || key.length < 12) return key;
  
  // Set default options
  const {
    prefixLength = 6,
    suffixLength = 4,
    separator = '...',
    addNpubPrefix = false
  } = options;
  
  // Check if the key is already an npub
  const isNpub = key.startsWith('npub1');
  
  let displayKey = key;
  
  // If it's not an npub and addNpubPrefix is true, try to convert it to npub
  if (!isNpub && addNpubPrefix) {
    try {
      // Try to encode the pubkey to npub
      displayKey = nip19.npubEncode(key);
    } catch (error) {
      console.error('Error encoding pubkey to npub:', error);
      // If encoding fails, add "npub" prefix manually
      displayKey = `npub${key}`;
    }
  }
  
  // Determine the starting position for truncation
  // If it's an npub or we added the npub prefix, start after "npub"
  const startPos = (isNpub || addNpubPrefix) ? 4 : 0;
  
  // Extract the prefix and suffix
  const prefix = displayKey.substring(0, startPos + prefixLength);
  const suffix = displayKey.substring(displayKey.length - suffixLength);
  
  // Return the truncated key
  return `${prefix}${separator}${suffix}`;
}

/**
 * Abridges a bech32 Nostr ID for display
 *
 * @param id The bech32 ID to abridge (e.g. npub1..., note1..., naddr1...)
 * @param options Abridge options
 * @returns Abridged ID string
 */
export function abridgeBech32Id(id: string, options: AbridgeBech32Options = {}): string {
  if (!id) return id;

  const cleanedId = id.startsWith('nostr:') ? id.slice('nostr:'.length) : id;
  const {
    prefixLength = 8,
    suffixLength = 4,
    separator = '...'
  } = options;

  if (cleanedId.length <= prefixLength + suffixLength + separator.length) {
    return cleanedId;
  }

  const prefix = cleanedId.substring(0, prefixLength);
  const suffix = cleanedId.substring(cleanedId.length - suffixLength);
  return `${prefix}${separator}${suffix}`;
}
