import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';

/**
 * Regular expression to match URLs in text
 */
export const URL_REGEX = /(https?:\/\/[\w\p{L}\p{N}\p{M}&.-/?=#\-@%+_,:!~*]+)/gu;

/**
 * Processor for URLs - asynchronous for consistency
 */
export const urlProcessor: ContentProcessor = {
  id: 'url',
  priority: 10,
  pattern: URL_REGEX,
  process: async (match: string | ChatMessage): Promise<ProcessorResult> => {
    // Handle the case when match is a ChatMessage (should never happen for pattern processors)
    const matchText = typeof match === 'string' ? match : match.content || '';
    
    return {
      result: matchText, // Keep URL as is in text
      metadata: {
        type: 'url',
        originalText: matchText,
        url: matchText
      }
    };
  }
};
