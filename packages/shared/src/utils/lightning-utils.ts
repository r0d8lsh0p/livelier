import { Invoice } from '@getalby/lightning-tools';

/**
 * Extract the amount in satoshis from a bolt11 invoice
 * 
 * @param invoice The bolt11 invoice string
 * @returns The amount in satoshis, or 0 if parsing fails
 */
export function getAmountFromInvoice(invoice: string): number {
  try {
    const _invoice = new Invoice({ pr: invoice });
    return _invoice.satoshi;
  } catch (error) {
    console.log('Error parsing invoice:');
    return 0;
  }
}

/**
 * Extract the zap amount in sats from a zap receipt's tags (NIP-57).
 * Tries the bolt11 invoice, then the embedded zap request's amount tag,
 * then a direct amount tag. Returns 0 when no amount can be determined.
 */
export function getZapReceiptAmountSats(tags: string[][]): number {
  const bolt11Tag = tags.find((tag) => tag[0] === 'bolt11');
  if (bolt11Tag && bolt11Tag[1]) {
    const fromInvoice = getAmountFromInvoice(bolt11Tag[1]);
    if (fromInvoice > 0) return fromInvoice;
  }

  const descriptionTag = tags.find((tag) => tag[0] === 'description');
  if (descriptionTag && descriptionTag[1]) {
    try {
      const zapRequest = JSON.parse(descriptionTag[1]) as { tags?: string[][] };
      const amountTag = zapRequest.tags?.find((tag) => tag[0] === 'amount');
      if (amountTag && amountTag[1]) {
        const amountMsat = parseInt(amountTag[1], 10);
        if (Number.isFinite(amountMsat)) return Math.floor(amountMsat / 1000);
      }
    } catch {
      // Malformed zap request — fall through to the direct amount tag
    }
  }

  const amountTag = tags.find((tag) => tag[0] === 'amount');
  if (amountTag && amountTag[1]) {
    const amountMsat = parseInt(amountTag[1], 10);
    if (Number.isFinite(amountMsat)) return Math.floor(amountMsat / 1000);
  }

  return 0;
}

/**
 * Extract the zap comment from a zap receipt (NIP-57).
 *
 * The user's message lives in the kind 9734 zap request embedded in the
 * receipt's description tag — most LNURL servers publish the 9735 receipt
 * with an EMPTY content field. Some servers duplicate the comment into the
 * receipt content instead, so that is the fallback. Returns '' when the
 * zap carries no comment.
 */
export function getZapReceiptMessage(tags: string[][], receiptContent: string): string {
  const descriptionTag = tags.find((tag) => tag[0] === 'description');
  if (descriptionTag && descriptionTag[1]) {
    try {
      const zapRequest = JSON.parse(descriptionTag[1]) as { content?: unknown };
      if (typeof zapRequest.content === 'string' && zapRequest.content.trim().length > 0) {
        return zapRequest.content;
      }
    } catch {
      // Malformed zap request — fall through to the receipt content
    }
  }

  return typeof receiptContent === 'string' ? receiptContent : '';
}

/**
 * Format a satoshi amount for display
 *
 * @param amount The amount in satoshis
 * @returns Formatted amount string (e.g., "1k" for 1000 sats, "1.5M" for 1,500,000 sats)
 */
export function formatAmount(amount: number): string {
  if (amount < 1000) return amount.toString();
  if (amount < 1000000) return `${Math.round(amount / 100) / 10}k`;
  return `${Math.round(amount / 100000) / 10}M`;
}
