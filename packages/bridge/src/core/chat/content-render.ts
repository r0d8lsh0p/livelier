import type { Event } from 'nostr-tools';
import {
  ContentToken,
  processMessageForDisplay,
} from '../../../../shared/src/utils/content-processor';

export interface RenderedContent {
  /** Plain-text serialization — the fallback every adapter can deliver. */
  text: string;
  /**
   * The processed token stream, for adapters that can render richer
   * output (links, emoji). Null when the pipeline failed and `text`
   * carries the raw, unprocessed content.
   */
  tokens: ContentToken[] | null;
}

/**
 * Serialize processed-content tokens to plain text.
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
 * links, custom emoji) and return both the token stream and its plain-text
 * form.
 *
 * Delivery must never fail on processing: any pipeline error falls back to
 * the raw content with a null token stream, which adapters deliver as
 * plain escaped text.
 */
export async function processNostrContent(event: Event): Promise<RenderedContent> {
  try {
    const processed = await processMessageForDisplay(event);
    const tokens = processed.tokens ?? [{ type: 'text', value: processed.text }];
    const text = renderTokensToText(tokens);
    if (!text.trim()) return { text: event.content, tokens: null };
    return { text, tokens };
  } catch {
    return { text: event.content, tokens: null };
  }
}
