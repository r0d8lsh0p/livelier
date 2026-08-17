import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';
import { abridgeBech32Id } from '../../nostr-key-utils';

/**
 * Regular expression to match note identifiers in text
 * Matches both with and without nostr: prefix
 */
export const NOTE_REGEX = /(nostr:)?(note1[a-z0-9]{58,59})/g;

/**
 * Processor for note identifiers - converts to njump.me URLs
 */
export const noteProcessor: ContentProcessor = {
  id: 'note',
  pattern: NOTE_REGEX,
  process: async (match: string | ChatMessage, prefix: string, noteId: string, offset: number, fullContent: string, context: any): Promise<ProcessorResult> => {
    try {
      // Handle the case when match is a ChatMessage (should never happen for pattern processors)
      const matchText = typeof match === 'string' ? match : match.content || '';
      
      // Create njump.me URL
      const url = `https://njump.me/${noteId}`;
      
      return {
        result: abridgeBech32Id(noteId),
        metadata: {
          type: 'url',
          originalText: matchText,
          url
        }
      };
    } catch (error) {
      console.error('Error processing note:', error);
      return { result: typeof match === 'string' ? match : match.content || '' };
    }
  }
};
