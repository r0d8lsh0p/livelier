// Import from the barrel: it runs registerAllProcessors() as a side effect,
// which populates the registry processContent reads from.
import { processContent } from './index';
import profileService from '../../nostr/services/profile.service';

// The npub processor resolves profiles over the network; stub it so these
// tests stay hermetic. It should never be reached for an npub inside a URL.
jest.mock('../../nostr/services/profile.service', () => ({
  __esModule: true,
  default: { getProfile: jest.fn().mockResolvedValue(null) },
}));

// A real, bech32-valid npub (pubkey 00…01) so the npub processor decodes it.
const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqshp52w2';

describe('content processor: URL vs npub ordering', () => {
  beforeEach(() => {
    (profileService.getProfile as jest.Mock).mockClear();
  });

  it('keeps an npub embedded in a URL intact (url tokenised first, npub skips it)', async () => {
    const url = `https://example.com/${NPUB}`;
    const { tokens = [], text } = await processContent(url, { processors: ['url', 'npub'] });

    const urlTokens = tokens.filter((t) => t.type === 'url');
    expect(urlTokens).toHaveLength(1);
    expect(urlTokens[0].value).toBe(url);
    expect(text).toBe(url);
    // The npub was never carved out into a mention…
    expect(tokens.some((t) => t.metadata?.type === 'mention')).toBe(false);
    // …and the network resolver was never touched.
    expect(profileService.getProfile).not.toHaveBeenCalled();
  });

  it('reproduces the break when url processing is absent (npub only)', async () => {
    const url = `https://example.com/${NPUB}`;
    const { text } = await processContent(url, { processors: ['npub'] });
    // Without url tokenisation the npub is rewritten, severing the link.
    expect(text).not.toBe(url);
  });

  it('still rewrites a standalone npub mention', async () => {
    const { tokens = [] } = await processContent(`hello ${NPUB}`, { processors: ['url', 'npub'] });
    expect(tokens.some((t) => t.metadata?.type === 'mention')).toBe(true);
  });
});
