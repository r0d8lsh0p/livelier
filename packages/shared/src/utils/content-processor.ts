/**
 * Content Processor Module
 * 
 * This module provides utilities for processing Nostr content, including converting
 * identifiers to user-friendly formats and formatting special message types.
 * 
 * The content processing workflow:
 * 
 * 1. Raw content with identifiers (e.g., "Hello nostr:npub123...") is passed to processContent()
 * 2. The function identifies patterns like npubs and replaces them with user-friendly text
 * 3. For each replacement, a ContentReplacement object is created with metadata
 * 4. The function returns a ProcessedContent object with both the transformed text and all replacements
 * 5. The application can then render the processed text and use the replacements for interactive elements
 */

/**
 * Re-exports from the modular content processor system:
 * 
 * processContent: The main function that processes raw content
 *   - Takes raw text content, a profile cache, and optional callback
 *   - Identifies patterns like npubs and replaces them with user-friendly text
 *   - Returns a ProcessedContent object with the processed text and replacements
 * 
 * ContentReplacement: Represents a single replacement made during content processing
 *   - Created for each pattern match (e.g., an npub identifier replaced with a username)
 *   - Contains metadata about the replacement (e.g., the pubkey for a mention)
 *   - Used by the application to create interactive elements (e.g., clickable mentions)
 * 
 * ProcessedContent: The result of content processing
 *   - Contains the processed text with all replacements applied
 *   - Contains an array of ContentReplacement objects for all replacements made
 *   - The application uses this to render both the text and any interactive elements
 * 
 * NPUB_REGEX: Regular expression to match npub identifiers in text
 * 
 * formatReaction: Formats reaction messages (kind 7) according to NIP-25
 * 
 * formatZapReceipt: Formats zap receipt messages (kind 9735)
 * 
 * getProfilePubkey: Determines which pubkey to use for profile display
 */
export {
  NPUB_REGEX,
  ContentReplacement,
  ContentToken,
  ProcessedContent,
  formatReaction,
  formatZapReceipt,
  processContent,
  processMessageForDisplay,
  getProfilePubkey
} from './content-processor/index';
