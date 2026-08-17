import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';
import { getZapReceiptAmountSats, getZapReceiptMessage } from '../../../utils/lightning-utils';

/**
 * Processor for zap receipt messages (kind 9735) - asynchronous for consistency
 */
export const zapProcessor: ContentProcessor = {
  id: 'zap',
  messageKind: 9735, // Zap receipt
  process: async (message: ChatMessage | string): Promise<ProcessorResult> => {
    // Handle the case when input is a string (should never happen for message processors)
    if (typeof message === 'string') {
      return { result: message };
    }

    // bolt11 → zap-request amount tag → direct amount tag (shared util);
    // default to 1 sat if the amount can't be determined
    const amountSat = getZapReceiptAmountSats(message.tags) || 1;

    // Comment lives in the embedded zap request, not the receipt content
    const comment = getZapReceiptMessage(message.tags, message.content);

    const formattedText = `Zapped ${amountSat} sats${comment ? `: ${comment}` : ''}`;

    return {
      result: formattedText,
      metadata: {
        type: 'zap',
        originalText: comment,
        amountSat
      }
    };
  }
};
