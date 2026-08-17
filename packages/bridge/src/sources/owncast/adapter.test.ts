import { OwncastAdapter, parseStreamingSince, toDiscoveredLive } from './adapter';
import { DirectoryInstance } from './discovery/types';

jest.mock('./discovery/directory.client', () => ({ fetchDirectory: jest.fn() }));
jest.mock('./discovery/liveness', () => ({ checkOwncastHlsLiveness: jest.fn() }));
jest.mock('./chat/owncast-listener', () => {
  const { EventEmitter } = require('events');
  class FakeListener extends EventEmitter {
    started = false;
    constructor(public instanceUrl: string) {
      super();
    }
    async start() {
      this.started = true;
    }
    stop() {
      this.started = false;
    }
  }
  return { OwncastChatListener: FakeListener };
});
const poolInstances: Array<Record<string, jest.Mock>> = [];
jest.mock('./chat/chat-pool', () => ({
  OwncastChatPool: jest.fn().mockImplementation(() => {
    const inst = {
      getOwncastUserIds: jest.fn().mockReturnValue(new Set<string>()),
      send: jest.fn().mockResolvedValue(undefined),
      destroyInstance: jest.fn(),
      destroyAll: jest.fn(),
    };
    poolInstances.push(inst);
    return inst;
  }),
}));

import { fetchDirectory } from './discovery/directory.client';
import { checkOwncastHlsLiveness } from './discovery/liveness';

const mockFetchDirectory = fetchDirectory as jest.MockedFunction<typeof fetchDirectory>;
const mockCheckHls = checkOwncastHlsLiveness as jest.MockedFunction<typeof checkOwncastHlsLiveness>;

const instance: DirectoryInstance = {
  id: 1,
  name: 'Chan',
  description: 'desc',
  streamTitle: 'Title',
  url: 'https://live.example',
  logo: '/logo',
  tags: [{ name: 'music', slug: 'music' }, { name: 'no-slug', slug: '' }],
  nsfw: false,
  lastSeen: '2026-08-10T07:00:00Z',
  streamingSince: '2026-08-10T06:00:00Z',
};

describe('parseStreamingSince', () => {
  it('parses ISO-8601 to unix seconds', () => {
    expect(parseStreamingSince('2026-08-10T06:00:00Z')).toBe(
      Math.floor(Date.parse('2026-08-10T06:00:00Z') / 1000)
    );
  });
  it('returns null for empty or invalid input', () => {
    expect(parseStreamingSince('')).toBeNull();
    expect(parseStreamingSince('not-a-date')).toBeNull();
  });
});

describe('toDiscoveredLive', () => {
  it('maps a directory instance to the normalized engine shape', () => {
    const live = toDiscoveredLive(instance);
    expect(live).toEqual({
      url: 'https://live.example',
      name: 'Chan',
      streamTitle: 'Title',
      description: 'desc',
      picture: 'https://live.example/logo',
      image: 'https://live.example/thumbnail.jpg',
      nsfw: false,
      startsAt: Math.floor(Date.parse('2026-08-10T06:00:00Z') / 1000),
      streamUrl: 'https://live.example/hls/stream.m3u8',
      tags: ['music'], // empty slugs filtered
    });
  });

  it('resolves absolute and missing logos', () => {
    expect(toDiscoveredLive({ ...instance, logo: 'https://cdn.example/x.png' }).picture).toBe(
      'https://cdn.example/x.png'
    );
    expect(toDiscoveredLive({ ...instance, logo: '' }).picture).toBe('https://live.example/logo');
  });
});

describe('OwncastAdapter', () => {
  const adapter = new OwncastAdapter({
    directoryUrl: 'https://dir.example/api/home',
    hlsTimeoutMs: 1234,
    bridgeName: 'Livelier',
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
  });

  it('declares its source identity', () => {
    expect(adapter.sourceKey).toBe('owncast');
    expect(adapter.sourceName).toBe('Owncast');
    expect(adapter.dTagPrefix).toBe('oc');
    expect(adapter.proxyProtocol).toBe('web');
  });

  it('fetchLive maps the directory live set and passes raw objects through', async () => {
    mockFetchDirectory.mockResolvedValue({
      live: [instance, { ...instance, url: 'https://nsfw.example', nsfw: true }],
      rawLive: [{ raw: 1 }, { raw: 2 }],
      all: [instance],
      fetchedAt: 1000,
      schemaVersion: 'v1',
    });

    const result = await adapter.fetchLive();
    expect(mockFetchDirectory).toHaveBeenCalledWith('https://dir.example/api/home', expect.any(Number));
    expect(result.schemaVersion).toBe('v1');
    expect(result.raw).toEqual([{ raw: 1 }, { raw: 2 }]);
    expect(result.live).toHaveLength(2);
    // NSFW instances are bridged, not filtered.
    expect(result.live[1]).toMatchObject({ url: 'https://nsfw.example', nsfw: true });
  });

  it('checkLiveness delegates to the slate-aware HLS probe with the configured timeout', async () => {
    mockCheckHls.mockResolvedValue('ended');
    await expect(adapter.checkLiveness('https://live.example/hls/stream.m3u8')).resolves.toBe('ended');
    expect(mockCheckHls).toHaveBeenCalledWith('https://live.example/hls/stream.m3u8', 1234);
  });

  describe('fetchViewerCount', () => {
    afterEach(() => {
      (global.fetch as jest.Mock | undefined)?.mockRestore?.();
    });

    it('returns the count when /api/status exposes it', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ online: true, viewerCount: 4 }),
      }) as never;
      await expect(adapter.fetchViewerCount('https://oc.example')).resolves.toBe(4);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://oc.example/api/status',
        expect.objectContaining({ signal: expect.anything() })
      );
    });

    it('returns null when the instance hides the count (field absent)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ online: true }),
      }) as never;
      await expect(adapter.fetchViewerCount('https://oc.example')).resolves.toBeNull();
    });

    it('returns undefined (no signal) on HTTP error or network failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false }) as never;
      await expect(adapter.fetchViewerCount('https://oc.example')).resolves.toBeUndefined();
      global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as never;
      await expect(adapter.fetchViewerCount('https://oc.example')).resolves.toBeUndefined();
    });
  });
});

describe('OwncastAdapter chat half', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

  function makeChatAdapter() {
    const adapter = new OwncastAdapter({
      directoryUrl: 'https://dir.example/api/home',
      hlsTimeoutMs: 1000,
      bridgeName: 'Livelier',
      log,
    });
    return { adapter, pool: poolInstances[poolInstances.length - 1] };
  }

  it('emits third-party messages as plain text, filtering pool echoes and empty bodies', async () => {
    const { adapter, pool } = makeChatAdapter();
    pool.getOwncastUserIds.mockReturnValue(new Set(['pool-user']));
    const onMessage = jest.fn();
    const listener = (await adapter.openListener('http://oc:8080', onMessage)) as never as {
      emit: (ev: string, msg: unknown) => void;
    };

    // Own sender-pool echo → dropped.
    listener.emit('chat', { userId: 'pool-user', displayName: 'X', body: '<p>echo</p>' });
    // Empty after HTML stripping → dropped.
    listener.emit('chat', { userId: 'u1', displayName: 'Bob', body: '<p></p>' });
    // Genuine third-party message → HTML converted to text.
    listener.emit('chat', { userId: 'u1', displayName: 'Bob', body: '<p>hello &amp; hi</p>' });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      userId: 'u1',
      displayName: 'Bob',
      text: 'hello & hi',
      emojis: [],
    });
  });

  it('extracts message emoji with instance-absolute URLs for NIP-30 tagging', async () => {
    const { adapter } = makeChatAdapter();
    const onMessage = jest.fn();
    const listener = (await adapter.openListener('http://oc:8080', onMessage)) as never as {
      emit: (ev: string, msg: unknown) => void;
    };

    listener.emit('chat', {
      userId: 'u1',
      displayName: 'Bob',
      body: '<p><img src="/img/emoji/neocat_cry_256.png" class="emoji" alt=":neocat_cry_256:"></p>',
    });

    expect(onMessage).toHaveBeenCalledWith({
      userId: 'u1',
      displayName: 'Bob',
      text: ':neocat_cry_256:',
      emojis: [
        { shortcode: 'neocat_cry_256', imageUrl: 'http://oc:8080/img/emoji/neocat_cry_256.png' },
      ],
    });
  });

  it('sendMessage inlines emoji matching the instance vocabulary, links the rest', async () => {
    const { adapter, pool } = makeChatAdapter();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'blob-dance', url: '/img/emoji/blob/blob-dance.gif' }],
    }) as never;

    await adapter.sendMessage('http://oc:8080', 'pk1', 'NostrAlice', 'gm :blob-dance: :foreign:', [
      { type: 'text', value: 'gm ' },
      {
        type: 'emoji',
        value: ':blob-dance:',
        metadata: { shortcode: 'blob-dance', imageUrl: 'https://their.site/blob.png' },
      },
      { type: 'text', value: ' ' },
      {
        type: 'emoji',
        value: ':foreign:',
        metadata: { shortcode: 'foreign', imageUrl: 'https://their.site/foreign.png' },
      },
    ]);

    expect(global.fetch).toHaveBeenCalledWith('http://oc:8080/api/emoji', expect.anything());
    expect(pool.send).toHaveBeenCalledWith(
      'http://oc:8080',
      'pk1',
      'NostrAlice',
      '<p>gm <img src="/img/emoji/blob/blob-dance.gif" class="emoji" alt=":blob-dance:" title=":blob-dance:"/> <a href="https://their.site/foreign.png">:foreign:</a></p>'
    );
    (global.fetch as jest.Mock).mockRestore?.();
  });

  it('sendMessage escapes text to Owncast HTML and routes through the pool', async () => {
    const { adapter, pool } = makeChatAdapter();
    await adapter.sendMessage('http://oc:8080', 'pk1', 'NostrAlice', 'hi <all>');
    expect(pool.send).toHaveBeenCalledWith(
      'http://oc:8080',
      'pk1',
      'NostrAlice',
      '<p>hi &lt;all&gt;</p>'
    );
  });

  it('room and global teardown reach the pool', () => {
    const { adapter, pool } = makeChatAdapter();
    adapter.closeRoom('http://oc:8080');
    expect(pool.destroyInstance).toHaveBeenCalledWith('http://oc:8080');
    adapter.closeAll();
    expect(pool.destroyAll).toHaveBeenCalled();
  });
});
