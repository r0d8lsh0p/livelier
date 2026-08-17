import { nip19 } from 'nostr-tools';
import { processContent } from '../content-processor';
import { abridgeBech32Id } from '../nostr-key-utils';

jest.mock('../../nostr/services/profile.service', () => ({
  __esModule: true,
  default: {
    getProfile: jest.fn(async () => null)
  }
}));

describe('content processor bech32 abridging', () => {
  it('abridges npub when profile lookup fails', async () => {
    const pubkey = 'f'.repeat(64);
    const npub = nip19.npubEncode(pubkey);
    const abridged = abridgeBech32Id(npub);
    const result = await processContent(`hello ${npub}`, { processors: ['npub'] });

    expect(result.text).toContain(abridged);
    expect(result.tokens?.some(token => token.type === 'mention' && token.value === abridged)).toBe(true);
  });

  it('abridges note IDs while keeping the full link target', async () => {
    const noteId = `note1${'b'.repeat(58)}`;
    const result = await processContent(`see ${noteId}`, { processors: ['note'] });

    expect(result.text).toContain('note1bbb...bbbb');
    const noteToken = result.tokens?.find(token => token.type === 'url');
    expect(noteToken?.value).toBe('note1bbb...bbbb');
    expect(noteToken?.metadata?.url).toBe(`https://njump.me/${noteId}`);
  });
});
