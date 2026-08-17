import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';
import { abridgeBech32Id } from '../../nostr-key-utils';

/**
 * Regular expression to match nevent identifiers in text
 * Matches both with and without nostr: prefix
 */
export const NEVENT_REGEX = /(nostr:)?(nevent1[a-z0-9]+)/g;

/**
 * Processor for nevent identifiers - converts to njump.me URLs
 */
export const neventProcessor: ContentProcessor = {
  id: 'nevent',
  pattern: NEVENT_REGEX,
  process: async (match: string | ChatMessage, prefix: string, neventId: string, offset: number, fullContent: string, context: any): Promise<ProcessorResult> => {
    try {
      // Handle the case when match is a ChatMessage (should never happen for pattern processors)
      const matchText = typeof match === 'string' ? match : match.content || '';
      
      // Create njump.me URL
      const url = `https://njump.me/${neventId}`;
      
      return {
        result: abridgeBech32Id(neventId),
        metadata: {
          type: 'url',
          originalText: matchText,
          url
        }
      };
    } catch (error) {
      console.error('Error processing nevent:', error);
      return { result: typeof match === 'string' ? match : match.content || '' };
    }
  }
};
