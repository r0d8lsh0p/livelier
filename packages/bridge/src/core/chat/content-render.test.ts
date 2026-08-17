import { nip19 } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import profileService from '../../../../shared/src/nostr/services/profile.service';
import { abridgeBech32Id } from '../../../../shared/src/utils/nostr-key-utils';
import { renderNostrContentToText, renderTokensToText } from './content-render';

jest.mock('../../../../shared/src/nostr/services/profile.service', () => ({
  __esModule: true,
  default: { getProfile: jest.fn().mockResolvedValue(null) },
}));

const getProfile = profileService.getProfile as jest.Mock;

const PUBKEY = '1'.repeat(64);
const NPUB = nip19.npubEncode(PUBKEY);
const NPROFILE = nip19.nprofileEncode({ pubkey: PUBKEY });
const NOTE = nip19.noteEncode('2'.repeat(64));
const NEVENT = nip19.neventEncode({ id: '3'.repeat(64) });
const NADDR = nip19.naddrEncode({ kind: 30311, pubkey: PUBKEY, identifier: 'room' });

function event(content: string, overrides: Partial<Event> = {}): Event {
  return {
    id: 'e'.repeat(64),
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    kind: 1311,
    tags: [],
    content,
    sig: 's'.repeat(128),
    ...overrides,
  };
}

beforeEach(() => {
  getProfile.mockReset().mockResolvedValue(null);
});

describe('renderNostrContentToText', () => {
  it('leaves plain text untouched', async () => {
    expect(await renderNostrContentToText(event('hello world'))).toBe('hello world');
  });

  it('renders an npub mention as @name when the profile resolves', async () => {
    getProfile.mockResolvedValue({ name: 'alice' });
    expect(await renderNostrContentToText(event(`hi nostr:${NPUB}`))).toBe('hi @alice');
  });

  it('renders an nprofile mention as @name when the profile resolves', async () => {
    getProfile.mockResolvedValue({ name: 'bob' });
    expect(await renderNostrContentToText(event(`hi ${NPROFILE}`))).toBe('hi @bob');
  });

  it('falls back to the abridged bech32 when the profile is unknown', async () => {
    const text = await renderNostrContentToText(event(`hi ${NPUB}`));
    expect(text).toBe(`hi ${abridgeBech32Id(NPUB)}`);
  });

  it('renders note/nevent/naddr refs as their njump link targets', async () => {
    for (const ref of [NOTE, NEVENT, NADDR]) {
      const text = await renderNostrContentToText(event(`see nostr:${ref}`));
      expect(text).toBe(`see https://njump.me/${ref}`);
    }
  });

  it('keeps plain URLs verbatim', async () => {
    const url = 'https://example.com/watch?v=1';
    expect(await renderNostrContentToText(event(`look ${url} now`))).toBe(`look ${url} now`);
  });

  it('keeps custom emoji shortcodes as text', async () => {
    const text = await renderNostrContentToText(
      event('gm :blob-dance:', { tags: [['emoji', 'blob-dance', 'https://x/blob.png']] })
    );
    expect(text).toBe('gm :blob-dance:');
  });

  it('delivers raw content when the pipeline throws', async () => {
    getProfile.mockRejectedValue(new Error('relay down'));
    // The npub processor catches lookup errors itself; force a pipeline-level
    // failure instead via malformed input to the trim call.
    const bad = { ...event('x'), content: undefined as unknown as string };
    expect(await renderNostrContentToText(bad)).toBe(bad.content);
  });

  it('delivers raw content when processing yields only whitespace', async () => {
    expect(await renderNostrContentToText(event('   '))).toBe('   ');
  });
});

describe('renderTokensToText', () => {
  it('prefers the link target for url tokens with an abridged display value', () => {
    const text = renderTokensToText([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'naddr1ab...cd', metadata: { url: 'https://njump.me/naddr1abcd' } },
    ]);
    expect(text).toBe('see https://njump.me/naddr1abcd');
  });

  it('uses the display value for everything else', () => {
    const text = renderTokensToText([
      { type: 'mention', value: '@alice', metadata: { pubkey: PUBKEY } },
      { type: 'text', value: ' hi' },
    ]);
    expect(text).toBe('@alice hi');
  });
});
