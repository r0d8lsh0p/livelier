import { parseDirectory } from './directory.client';

const instance = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Chan',
  description: 'desc',
  streamTitle: 'title',
  url: 'https://a.example',
  logo: '/logo',
  tags: [{ name: 'x', slug: 'x' }],
  nsfw: false,
  lastSeen: '2026-08-10T07:00:00Z',
  streamingSince: '2026-08-10T06:00:00Z',
  ...over,
});

describe('parseDirectory', () => {
  it('treats online:true sections as the live set (not streamingSince)', () => {
    const payload = {
      sections: [
        { name: 'Live', online: true, instances: [instance({ url: 'https://live.example' })] },
        {
          name: 'Offline',
          online: false,
          // still has streamingSince, but must NOT count as live
          instances: [instance({ url: 'https://off.example' })],
        },
      ],
    };
    const parsed = parseDirectory(payload, 1000);
    expect(parsed.live.map((i) => i.url)).toEqual(['https://live.example']);
    expect(parsed.all).toHaveLength(2);
    expect(parsed.fetchedAt).toBe(1000);
  });

  it('skips instances with a missing or non-http url', () => {
    const payload = {
      sections: [
        {
          name: 'Live',
          online: true,
          instances: [
            instance({ url: 'https://ok.example' }),
            instance({ url: '' }),
            instance({ url: 'ftp://bad.example' }),
            { garbage: true },
          ],
        },
      ],
    };
    const parsed = parseDirectory(payload, 0);
    expect(parsed.live.map((i) => i.url)).toEqual(['https://ok.example']);
  });

  it('dedupes by normalized url across sections', () => {
    const payload = {
      sections: [
        { name: 'Live', online: true, instances: [instance({ url: 'https://A.example/' })] },
        { name: 'More', online: false, instances: [instance({ url: 'https://a.example' })] },
      ],
    };
    const parsed = parseDirectory(payload, 0);
    expect(parsed.all).toHaveLength(1);
    expect(parsed.live).toHaveLength(1);
  });

  it('is resilient to a malformed payload', () => {
    expect(parseDirectory(null, 0).all).toEqual([]);
    expect(parseDirectory({}, 0).all).toEqual([]);
    expect(parseDirectory({ sections: 'nope' }, 0).all).toEqual([]);
  });

  it('coerces missing optional fields to safe defaults', () => {
    const payload = {
      sections: [
        { name: 'Live', online: true, instances: [{ url: 'https://a.example' }] },
      ],
    };
    const [only] = parseDirectory(payload, 0).all;
    expect(only.name).toBe('');
    expect(only.nsfw).toBe(false);
    expect(only.tags).toEqual([]);
  });
});
