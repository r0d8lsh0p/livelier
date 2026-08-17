import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';

/**
 * Processor for reaction messages (kind 7) - asynchronous for consistency
 */
export const reactionProcessor: ContentProcessor = {
  id: 'reaction',
  messageKind: 7, // NIP-25 reaction
  process: async (message: ChatMessage | string): Promise<ProcessorResult> => {
    // Handle the case when input is a string (should never happen for message processors)
    if (typeof message === 'string') {
      return { result: message };
    }
    
    // Handle empty content as "+" per NIP-25
    const content = message.content || '+';
    
    // Interpret the reaction
    let reaction = content;
    if (content === '+') reaction = '👍';
    if (content === '-') reaction = '👎';
    
    // Just return the emoji or content directly
    return {
      result: reaction,
      metadata: {
        type: 'reaction',
        originalText: content,
        reaction
      }
    };
  }
};
