import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';
import { abridgeBech32Id } from '../../nostr-key-utils';

/**
 * Regular expression to match naddr identifiers in text
 * Matches both with and without nostr: prefix
 */
export const NADDR_REGEX = /(nostr:)?(naddr1[a-z0-9]+)/g;

/**
 * Processor for naddr identifiers - converts to njump.me URLs
 */
export const naddrProcessor: ContentProcessor = {
  id: 'naddr',
  pattern: NADDR_REGEX,
  process: async (match: string | ChatMessage, prefix: string, naddrId: string, offset: number, fullContent: string, context: any): Promise<ProcessorResult> => {
    try {
      // Handle the case when match is a ChatMessage (should never happen for pattern processors)
      const matchText = typeof match === 'string' ? match : match.content || '';
      
      // Create njump.me URL
      const url = `https://njump.me/${naddrId}`;
      
      return {
        result: abridgeBech32Id(naddrId),
        metadata: {
          type: 'url',
          originalText: matchText,
          url
        }
      };
    } catch (error) {
      console.error('Error processing naddr:', error);
      return { result: typeof match === 'string' ? match : match.content || '' };
    }
  }
};
