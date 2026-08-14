/**
 * Unit tests for ClientServiceGateway with client.service mocked. The critical
 * invariant: the 1311 subscription filter must carry NO `#a` — an `#a`-scoped
 * subscription from the bridge would register as viewer demand on the relay's
 * /demand endpoint and hold Owncast chat connections open forever.
 */
import { ClientServiceGateway } from './nostr-gateway';

jest.mock('./client', () => ({
  nostrClient: {
    setClientName: jest.fn(),
    createSignedEvent: jest.fn().mockResolvedValue({ id: 'e1', kind: 1311 }),
    publishEvent: jest.fn().mockResolvedValue({}),
    subscribe: jest.fn().mockReturnValue({ close: jest.fn() }),
    query: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('./authed-publish', () => ({
  publishAuthed: jest.fn().mockResolvedValue(undefined),
}));
// The shared profile stack (read-only use). Mocked at the module boundary —
// unit tests must not touch relays or the coordinator's caches.
jest.mock('../../../shared/src/nostr/services/profile.service', () => ({
  __esModule: true,
  default: { getProfile: jest.fn().mockResolvedValue(null) },
}));

import { nostrClient } from './client';
import { publishAuthed } from './authed-publish';
import profileService from '../../../shared/src/nostr/services/profile.service';

const mocked = nostrClient as jest.Mocked<typeof nostrClient>;
const mockedPublishAuthed = publishAuthed as jest.MockedFunction<typeof publishAuthed>;
const mockedGetProfile = profileService.getProfile as jest.MockedFunction<
  typeof profileService.getProfile
>;

describe('ClientServiceGateway', () => {
  afterEach(() => jest.clearAllMocks());

  it('subscribe1311 opens an unscoped kind-1311 firehose on the one local relay', () => {
    const gateway = new ClientServiceGateway('ws://relay:8080');
    const onevent = jest.fn();
    const sub = gateway.subscribe1311(onevent);

    expect(mocked.subscribe).toHaveBeenCalledTimes(1);
    const [relays, filterArg, handlers] = mocked.subscribe.mock.calls[0];
    expect(relays).toEqual(['ws://relay:8080']);
    expect(Array.isArray(filterArg)).toBe(false);
    const filter = filterArg as Exclude<typeof filterArg, unknown[]>;
    expect(filter).not.toHaveProperty('#a');
    expect(filter.kinds).toEqual([1311]);
    expect(typeof filter.since).toBe('number');
    expect(handlers).toEqual({ onevent });
    expect(sub).toHaveProperty('close');
  });

  it('publish signs via client.service (client tag) and sends via authed one-shot', async () => {
    const gateway = new ClientServiceGateway('ws://relay:8080');
    const signer = { getPublicKey: () => 'pk' } as never;
    await gateway.publish(signer, 1311, 'hi', [['-']]);
    expect(mocked.createSignedEvent).toHaveBeenCalledWith(signer, 1311, 'hi', [['-']]);
    expect(mockedPublishAuthed).toHaveBeenCalledWith('ws://relay:8080', signer, {
      id: 'e1',
      kind: 1311,
    });
  });

  it('publish propagates relay rejection (no silent OK=false)', async () => {
    mockedPublishAuthed.mockRejectedValueOnce(new Error('relay rejected kind 1311 event: nope'));
    const gateway = new ClientServiceGateway('ws://relay:8080');
    const signer = { getPublicKey: () => 'pk' } as never;
    await expect(gateway.publish(signer, 1311, 'hi', [['-']])).rejects.toThrow(
      'relay rejected kind 1311'
    );
  });

  it('fetchProfileName returns null when neither the network nor the local relay knows the pubkey', async () => {
    const gateway = new ClientServiceGateway('ws://relay:8080');
    await expect(gateway.fetchProfileName('a'.repeat(64))).resolves.toBeNull();
  });

  it('fetchProfileName prefers the shared profile stack (network-canonical identity)', async () => {
    mockedGetProfile.mockResolvedValueOnce({ name: 'Quiet Owl', picture: null, timestamp: 1 });
    mocked.query.mockResolvedValueOnce([
      { kind: 0, content: '{"name":"LocalOnly"}', created_at: 1 } as never,
    ]);
    const gateway = new ClientServiceGateway('ws://relay:8080');
    await expect(gateway.fetchProfileName('a'.repeat(64))).resolves.toBe('Quiet Owl');
  });

  it('fetchProfileName falls back to the local chat relay when the network misses', async () => {
    mocked.query.mockResolvedValueOnce([
      { kind: 0, content: '{"name":"LocalOnly"}', created_at: 1 } as never,
    ]);
    const gateway = new ClientServiceGateway('ws://relay:8080');
    await expect(gateway.fetchProfileName('a'.repeat(64))).resolves.toBe('LocalOnly');
    const [relays] = mocked.query.mock.calls[0];
    expect(relays).toEqual(['ws://relay:8080']); // direct query stays local-only
  });

  it('fetchProfileName survives a profile-stack failure (local result still lands)', async () => {
    mockedGetProfile.mockRejectedValueOnce(new Error('coordinator down'));
    mocked.query.mockResolvedValueOnce([
      { kind: 0, content: '{"name":"LocalOnly"}', created_at: 1 } as never,
    ]);
    const gateway = new ClientServiceGateway('ws://relay:8080');
    await expect(gateway.fetchProfileName('a'.repeat(64))).resolves.toBe('LocalOnly');
  });

  it('broadcast plain-publishes to exactly the given relay list (no NIP-42)', async () => {
    const gateway = new ClientServiceGateway('ws://relay:8080');
    const signer = { getPublicKey: () => 'pk' } as never;
    await gateway.broadcast(signer, 0, '{}', [], ['ws://relay:8080', 'wss://dummy-purple.local']);
    expect(mocked.publishEvent).toHaveBeenCalledWith({ id: 'e1', kind: 1311 }, [
      'ws://relay:8080',
      'wss://dummy-purple.local',
    ]);
    expect(mockedPublishAuthed).not.toHaveBeenCalled();
  });

  it('subscribeNetworkChat is a wide chat-kind firehose (no #a — relay filter caps and resub churn)', () => {
    const gateway = new ClientServiceGateway('ws://relay:8080');
    const onevent = jest.fn();
    gateway.subscribeNetworkChat(['wss://dummy-net.local'], onevent);
    const call = mocked.subscribe.mock.calls.at(-1);
    expect(call?.[0]).toEqual(['wss://dummy-net.local']);
    const filter = call?.[1] as { kinds: number[]; since: number };
    expect(filter.kinds).toEqual([1311, 1312, 1313]);
    expect(filter).not.toHaveProperty('#a');
    expect(typeof filter.since).toBe('number');
  });
});
