import type { ChatMessage } from '../../nostr/services/nostr-chat.service';
import { getProfilePubkey } from '../content-processor';

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'id',
    pubkey: 'author-pubkey',
    content: '',
    created_at: 0,
    kind: 1,
    tags: [],
    ...overrides,
  };
}

describe('getProfilePubkey', () => {
  it('returns message pubkey for non-zap kinds', () => {
    const message = createMessage({ kind: 1, pubkey: 'note-author' });
    expect(getProfilePubkey(message)).toBe('note-author');
  });

  it('uses P tag as zap sender when present', () => {
    const message = createMessage({
      kind: 9735,
      pubkey: 'receipt-author',
      tags: [['P', 'zapper-pubkey']],
    });
    expect(getProfilePubkey(message)).toBe('zapper-pubkey');
  });

  it('uses description zap request pubkey as sender when P tag is missing', () => {
    const zapRequest = {
      id: 'zap-request-id',
      pubkey: 'payer-pubkey',
      created_at: 123,
      kind: 9734,
      tags: [],
      content: '',
      sig: 'sig',
    };

    const message = createMessage({
      kind: 9735,
      pubkey: 'wallet-pubkey',
      tags: [['description', JSON.stringify(zapRequest)]],
    });

    expect(getProfilePubkey(message)).toBe('payer-pubkey');
  });

  it('falls back to receipt pubkey when description is invalid', () => {
    const message = createMessage({
      kind: 9735,
      pubkey: 'receipt-author',
      tags: [['description', '{not-json']],
    });
    expect(getProfilePubkey(message)).toBe('receipt-author');
  });
});

