import { buildLiveEventTags } from './live-event-tags';
import type { StreamMeta } from '../streaming/stream-meta';

const meta: StreamMeta = {
  title: 'My Stream',
  summary: 'A summary',
  image: 'https://example.com/img.jpg',
};

const base = {
  dTag: 'abc123',
  metadata: meta,
  streamingUrl: 'https://example.com/hls/stream.m3u8',
  hostPubkey: 'f'.repeat(64),
  status: 'live' as const,
  startsTimestamp: 1700000000,
};

describe('buildLiveEventTags', () => {
  it('produces the canonical NIP-53 base tag set (order-stable)', () => {
    expect(buildLiveEventTags(base)).toEqual([
      ['d', 'abc123'],
      ['title', 'My Stream'],
      ['summary', 'A summary'],
      ['image', 'https://example.com/img.jpg'],
      ['streaming', 'https://example.com/hls/stream.m3u8'],
      ['status', 'live'],
      ['starts', '1700000000'],
      ['p', 'f'.repeat(64), '', 'host'],
    ]);
  });

  it('appends t tags for hashtags', () => {
    const tags = buildLiveEventTags({ ...base, metadata: { ...meta, tags: ['music', 'live'] } });
    expect(tags).toContainEqual(['t', 'music']);
    expect(tags).toContainEqual(['t', 'live']);
  });

  it('appends a single relays tag with all relay urls (NIP-53)', () => {
    const tags = buildLiveEventTags({ ...base, relays: ['wss://relay.local'] });
    expect(tags).toContainEqual(['relays', 'wss://relay.local']);
    // exactly one relays tag
    expect(tags.filter((t) => t[0] === 'relays')).toHaveLength(1);
  });

  it('appends a proxy tag defaulting protocol to web (NIP-48)', () => {
    const tags = buildLiveEventTags({ ...base, proxy: { url: 'https://owncast.example' } });
    expect(tags).toContainEqual(['proxy', 'https://owncast.example', 'web']);
  });

  it('honours an explicit proxy protocol', () => {
    const tags = buildLiveEventTags({
      ...base,
      proxy: { url: 'https://a.example', protocol: 'activitypub' },
    });
    expect(tags).toContainEqual(['proxy', 'https://a.example', 'activitypub']);
  });

  it('appends a NIP-36 content-warning tag when provided', () => {
    const tags = buildLiveEventTags({ ...base, contentWarning: 'nsfw' });
    expect(tags).toContainEqual(['content-warning', 'nsfw']);
  });

  it('omits relays, proxy, and content-warning tags when not provided', () => {
    const tags = buildLiveEventTags(base);
    expect(tags.some((t) => t[0] === 'relays')).toBe(false);
    expect(tags.some((t) => t[0] === 'proxy')).toBe(false);
    expect(tags.some((t) => t[0] === 'content-warning')).toBe(false);
  });

  it('appends current_participants when provided, including zero (NIP-53)', () => {
    expect(buildLiveEventTags({ ...base, currentParticipants: 4 })).toContainEqual([
      'current_participants',
      '4',
    ]);
    expect(buildLiveEventTags({ ...base, currentParticipants: 0 })).toContainEqual([
      'current_participants',
      '0',
    ]);
  });

  it('omits current_participants when not provided', () => {
    const tags = buildLiveEventTags(base);
    expect(tags.some((t) => t[0] === 'current_participants')).toBe(false);
  });
});
