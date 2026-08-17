// Export types
export * from './types';

// Export registry functions
export * from './registry';

// Export pipeline functions
export * from './pipeline';

// Export processors
export * from './processors';

// Import dependencies
import type { ChatMessage } from '../../nostr/services/nostr-chat.service';
import { ProcessedContent, ProcessorContext, ContentToken } from './types';
import { processContent as processContentInternal, processMessage } from './pipeline';
import { registerAllProcessors } from './processors';
import { NPUB_REGEX } from './processors/npub-processor';

// Register all processors
registerAllProcessors();

// Export NPUB_REGEX and ContentToken for external use
export { NPUB_REGEX, ContentToken };

/**
 * Get the pubkey to use for profile display
 * 
 * For zap receipts (kind 9735), use the sender's pubkey from the P tag
 * For other messages, use the author's pubkey
 * 
 * @param message The chat message
 * @returns The pubkey to use for profile display
 */
export function getProfilePubkey(message: ChatMessage): string {
  // For zap receipts (kind 9735), prefer the zapper's pubkey (sender), not the receipt author.
  // Some wallets (e.g. Wallet of Satoshi) publish receipts from a wallet pubkey, while the
  // actual payer is embedded in the zap request inside the `description` tag (kind 9734).
  if (message.kind === 9735) {
    const senderTag = message.tags.find(tag => tag[0] === 'P');
    if (senderTag && senderTag[1]) {
      return senderTag[1];
    }

    const descriptionTag = message.tags.find(tag => tag[0] === 'description');
    if (descriptionTag && descriptionTag[1]) {
      try {
        const zapRequest = JSON.parse(descriptionTag[1]);
        if (zapRequest?.kind === 9734 && typeof zapRequest.pubkey === 'string' && zapRequest.pubkey.length > 0) {
          return zapRequest.pubkey;
        }
      } catch {
        // Ignore invalid description payloads
      }
    }
  }
  
  // For other messages, use the author's pubkey
  return message.pubkey;
}

/**
 * Format a reaction message (kind 7) according to NIP-25
 * 
 * @param message The reaction message to format
 * @returns Promise resolving to formatted reaction message text
 */
export async function formatReaction(message: ChatMessage): Promise<string> {
  return processMessage(message, { processors: ['reaction'] });
}

/**
 * Format a zap receipt message
 * 
 * @param message The zap receipt message to format
 * @returns Promise resolving to formatted zap message text
 */
export async function formatZapReceipt(message: ChatMessage): Promise<string> {
  return processMessage(message, { processors: ['zap'] });
}

/**
 * Canonical per-kind display processing for a message — the single dispatch
 * used by the chat panel and the notifications inbox (issue #1198), so a
 * given event renders identically on both surfaces:
 * - 9735 zap receipts → formatted "Zapped N sats" text
 * - 7 reactions → custom-emoji processing when emoji tags exist, else
 *   NIP-25 interpretation (+/- → 👍/👎)
 * - everything else (1, 1111, 1311, …) → full in-content processing
 *   (custom emoji, npub/nprofile → usernames, urls, embedded events)
 */
export async function processMessageForDisplay(message: ChatMessage): Promise<ProcessedContent> {
  if (message.kind === 9735) {
    const zapText = await formatZapReceipt(message);
    return { text: zapText, replacements: [], tokens: [{ type: 'text', value: zapText }] };
  }

  if (message.kind === 7) {
    if (message.tags.some((tag) => tag[0] === 'emoji') && message.content) {
      return processContentInternal(message.content, {
        processors: ['emoji'],
        context: { event: message, message },
      });
    }
    const reactionText = await formatReaction(message);
    return { text: reactionText, replacements: [], tokens: [{ type: 'text', value: reactionText }] };
  }

  // Trim stray leading/trailing whitespace and newlines (// applies to the chat panel too — this is the shared dispatch)
  const content = message.content?.trim();
  if (content) {
    return processContentInternal(content, {
      processors: ['emoji', 'npub', 'nprofile', 'url', 'note', 'nevent', 'naddr'],
      context: { event: message, message },
    });
  }

  return { text: '', replacements: [], tokens: [] };
}

/**
 * Process content to replace identifiers with usernames and format special content
 *
 * @param content The text content to process
 * @param options Processing options including which processors to use
 * @returns Promise resolving to the processed content
 */
export async function processContent(
  content: string,
  options: {
    processors?: string[];
    context?: ProcessorContext;
  } = {}
): Promise<ProcessedContent> {
  return processContentInternal(content, options);
}
