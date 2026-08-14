import { checkOwncastHlsLiveness } from './liveness';

describe('checkOwncastHlsLiveness', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const mockFetchSequence = (responses: Array<{ ok: boolean; body: string }>) => {
    const fn = jest.fn();
    for (const r of responses) {
      fn.mockResolvedValueOnce({ ok: r.ok, text: async () => r.body });
    }
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  };

  const MASTER = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=1\n0/stream.m3u8\n';
  const MEDIA_LIVE = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:5.0,\nstream-42.ts\n';
  const MEDIA_OFFLINE_SLATE =
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:5.0,\nstream-offline-0.ts\n#EXTINF:3.1,\nstream-offline-1.ts\n';

  it('follows a master playlist and reads live from real segments', async () => {
    const fn = mockFetchSequence([
      { ok: true, body: MASTER },
      { ok: true, body: MEDIA_LIVE },
    ]);
    expect(await checkOwncastHlsLiveness('https://x/hls/stream.m3u8')).toBe('live');
    // variant resolved relative to the master URL
    expect(fn.mock.calls[1][0]).toBe('https://x/hls/0/stream.m3u8');
  });

  it('detects the Owncast offline slate behind a master playlist as ended', async () => {
    mockFetchSequence([
      { ok: true, body: MASTER },
      { ok: true, body: MEDIA_OFFLINE_SLATE },
    ]);
    expect(await checkOwncastHlsLiveness('https://x/hls/stream.m3u8')).toBe('ended');
  });

  it('handles a direct media playlist (live and slate)', async () => {
    mockFetchSequence([{ ok: true, body: MEDIA_LIVE }]);
    expect(await checkOwncastHlsLiveness('https://x/hls/0/stream.m3u8')).toBe('live');
    mockFetchSequence([{ ok: true, body: MEDIA_OFFLINE_SLATE }]);
    expect(await checkOwncastHlsLiveness('https://x/hls/0/stream.m3u8')).toBe('ended');
  });

  it('returns ended on ENDLIST at either level', async () => {
    mockFetchSequence([{ ok: true, body: MEDIA_LIVE + '#EXT-X-ENDLIST\n' }]);
    expect(await checkOwncastHlsLiveness('https://x/hls/stream.m3u8')).toBe('ended');
  });

  it('returns error on http failure, unparseable master, or fetch throw', async () => {
    mockFetchSequence([{ ok: false, body: '' }]);
    expect(await checkOwncastHlsLiveness('https://x/hls/stream.m3u8')).toBe('error');
    mockFetchSequence([{ ok: true, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n' }]);
    expect(await checkOwncastHlsLiveness('https://x/hls/stream.m3u8')).toBe('error');
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    expect(await checkOwncastHlsLiveness('https://x/hls/stream.m3u8')).toBe('error');
  });
});
