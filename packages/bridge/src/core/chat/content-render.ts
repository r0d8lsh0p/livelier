import type { Event } from 'nostr-tools';
import {
  ContentToken,
  processMessageForDisplay,
} from '../../../../shared/src/utils/content-processor';

/**
 * Serialize processed-content tokens to plain text for a source chat.
 *
 * Plain text cannot carry an href, so tokens whose display value is an
 * abridged label (note/nevent/naddr → njump) render as their link target —
 * otherwise the reference would be unreachable from the source side.
 * Everything else (text, mentions, emoji shortcodes) renders as its
 * display value, matching what a Nostr client shows.
 */
export function renderTokensToText(tokens: ContentToken[]): string {
  return tokens
    .map((token) =>
      token.type === 'url' && typeof token.metadata?.url === 'string'
        ? token.metadata.url
        : token.value
    )
    .join('');
}

/**
 * Run a chat event's content through the shared content pipeline (the same
 * per-kind dispatch Nostr clients use: mentions → names, bech32 refs →
 * links, custom emoji) and flatten the result to source-chat plain text.
 *
 * Delivery must never fail on processing: any pipeline error falls back to
 * the raw content, which is what the bridge historically delivered.
 */
export async function renderNostrContentToText(event: Event): Promise<string> {
  try {
    const processed = await processMessageForDisplay(event);
    const tokens = processed.tokens ?? [{ type: 'text', value: processed.text }];
    const text = renderTokensToText(tokens);
    return text.trim() ? text : event.content;
  } catch {
    return event.content;
  }
}
