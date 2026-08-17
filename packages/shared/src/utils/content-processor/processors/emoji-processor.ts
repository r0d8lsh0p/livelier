import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';

/**
 * Regular expression to match custom emoji shortcodes in text
 * Matches :shortcode: where shortcode contains alphanumeric characters, underscores, and hyphens
 * 
 * Note: While NIP-30 spec technically states shortcodes should only contain
 * alphanumeric characters and underscores, we also support hyphens as they are
 * commonly used in practice (e.g., "blob-dance")
 */
export const EMOJI_SHORTCODE_REGEX = /:([a-zA-Z0-9_-]+):/g;

/**
 * Extract emoji definitions from a Nostr event's tags
 * 
 * @param event The Nostr event containing emoji tags
 * @returns Map of shortcode to image URL
 */
function extractEmojiDefinitions(event: ChatMessage): Map<string, string> {
  const emojiMap = new Map<string, string>();
  
  if (!event.tags || !Array.isArray(event.tags)) {
    return emojiMap;
  }
  
  // Parse emoji tags: ["emoji", "shortcode", "image-url"]
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag.length >= 3 && tag[0] === 'emoji') {
      const shortcode = tag[1];
      const imageUrl = tag[2];
      
      // Validate shortcode format (alphanumeric, underscores, and hyphens)
      if (typeof shortcode === 'string' && 
          typeof imageUrl === 'string' && 
          /^[a-zA-Z0-9_-]+$/.test(shortcode) &&
          imageUrl.trim()) {
        emojiMap.set(shortcode, imageUrl.trim());
      }
    }
  }
  
  return emojiMap;
}

/**
 * Processor for custom emoji shortcodes according to NIP-30
 */
export const emojiProcessor: ContentProcessor = {
  id: 'emoji',
  pattern: EMOJI_SHORTCODE_REGEX,
  priority: 5, // Process after text but before other formatting
  process: async (
    match: string | ChatMessage, 
    shortcode: string, 
    offset: number, 
    fullContent: string, 
    context: any
  ): Promise<ProcessorResult> => {
    // Handle the case when match is a ChatMessage (should never happen for pattern processors)
    const matchText = typeof match === 'string' ? match : match.content || '';
    
    // Get the Nostr event from context
    const event = context?.event || context?.message;
    
    if (!event || !event.tags) {
      // No event context or tags, return original text
      return { result: matchText };
    }
    
    // Extract emoji definitions from the event
    const emojiDefinitions = extractEmojiDefinitions(event);
    
    // Check if this shortcode has a corresponding emoji tag
    const imageUrl = emojiDefinitions.get(shortcode);
    
    if (!imageUrl) {
      // No matching emoji tag found, return original text
      return { result: matchText };
    }
    
    // Return emoji token with metadata
    return {
      result: matchText, // Keep the shortcode as display text for now
      metadata: {
        type: 'emoji',
        originalText: matchText,
        shortcode,
        imageUrl,
        altText: shortcode // Use shortcode as alt text
      }
    };
  }
};
