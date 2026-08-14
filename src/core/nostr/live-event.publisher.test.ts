/**
 * LiveEventPublisher: the NIP-53 `relays` hint on 30311s names the chat relay
 * ONLY — clients read and write the 1311 room there (zap.stream uses just the
 * first URL of the tag), and the event relay's write whitelist would reject
 * their chat.
 */
import { LiveEventPublisher } from './live-event.publisher';
import { DerivedKeySigner } from '../../../shared/src/nostr/signers/derived-key.signer';

jest.mock('./client', () => ({
  nostrClient: {
    setClientName: jest.fn(),
    createSignedEvent: jest.fn(async (_s: unknown, kind: number, content: string, tags: string[][]) => ({
      kind,
      content,
      tags,
      id: 'x',
      sig: 'x',
      pubkey: 'x',
      created_at: 0,
    })),
    publishEvent: jest.fn(async (_e: unknown, relays: string[]) =>
      Object.fromEntries(relays.map((r) => [r, true]))
    ),
    subscribe: jest.fn(),
    query: jest.fn(),
  },
}));

import { nostrClient } from './client';

const mocked = nostrClient as jest.Mocked<typeof nostrClient>;

const liveInput = {
  signer: new DerivedKeySigner('01'.repeat(32)),
  hostPubkey: 'ab'.repeat(32),
  dTag: 'owncast-live-test',
  metadata: { title: 'Test', summary: '', image: '', tags: [] },
  streamingUrl: 'https://host.example/hls/stream.m3u8',
  startsTimestamp: 1000,
  status: 'live' as const,
  proxyUrl: 'https://host.example',
  proxyProtocol: 'web' as const,
  relayUrl: 'wss://event.example',
  nsfw: false,
};

describe('LiveEventPublisher.publishLiveEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hints the chat relay ONLY in the NIP-53 relays tag, publishes to the event relay', async () => {
    const publisher = new LiveEventPublisher();
    await publisher.publishLiveEvent({ ...liveInput, chatRelayUrl: 'wss://chat.example' });

    const tags = mocked.createSignedEvent.mock.calls[0][3] as string[][];
    expect(tags.filter((t) => t[0] === 'relays')).toEqual([['relays', 'wss://chat.example']]);
    expect(mocked.publishEvent).toHaveBeenCalledWith(expect.anything(), ['wss://event.example']);
  });

  it('falls back to the event relay in the hint for single-relay setups', async () => {
    const publisher = new LiveEventPublisher();
    await publisher.publishLiveEvent(liveInput);

    const tags = mocked.createSignedEvent.mock.calls[0][3] as string[][];
    expect(tags.filter((t) => t[0] === 'relays')).toEqual([['relays', 'wss://event.example']]);
  });
});

describe('LiveEventPublisher retraction primitives (used by scripts/retract-instance.ts)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retractLiveEvent publishes a kind-5 naming the 30311 coordinate, event relay only', async () => {
    const publisher = new LiveEventPublisher();
    const signer = new DerivedKeySigner('01'.repeat(32));
    await publisher.retractLiveEvent(signer, 'oc-0123456789abcdef', 'wss://event.example');

    const [, kind, , tags] = mocked.createSignedEvent.mock.calls[0];
    expect(kind).toBe(5);
    expect(tags).toContainEqual(['a', `30311:${signer.getPublicKey()}:oc-0123456789abcdef`]);
    expect(tags).toContainEqual(['k', '30311']);
    expect(mocked.publishEvent).toHaveBeenCalledWith(expect.anything(), ['wss://event.example']);
  });

  it('blankProfile replaces the kind-0 with empty content on the given relays', async () => {
    const publisher = new LiveEventPublisher();
    await publisher.blankProfile(new DerivedKeySigner('02'.repeat(32)), [
      'wss://chat.example',
      'wss://purple.example',
    ]);

    const [, kind, content] = mocked.createSignedEvent.mock.calls[0];
    expect(kind).toBe(0);
    expect(content).toBe('{}');
    expect(mocked.publishEvent).toHaveBeenCalledWith(expect.anything(), [
      'wss://chat.example',
      'wss://purple.example',
    ]);
  });
});
