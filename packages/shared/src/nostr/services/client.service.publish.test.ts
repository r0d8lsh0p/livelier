/**
 * WRITE CONTAINMENT as mechanism, not policy: a publish that names no
 * relays must throw before anything touches the network. The default-write-
 * relay fallback was deliberately removed — this pins it out of existence.
 */
import type { Event } from 'nostr-tools';
import clientService from './client.service';

const event: Event = {
  id: 'e'.repeat(64),
  pubkey: 'a'.repeat(64),
  kind: 1311,
  content: 'contained',
  created_at: 1700000000,
  sig: 's'.repeat(128),
  tags: [],
};

describe('publishEvent relay outcomes', () => {
  const svc = clientService as unknown as { pool: unknown };
  let realPool: unknown;
  beforeEach(() => {
    realPool = svc.pool;
  });
  afterEach(() => {
    svc.pool = realPool;
  });

  it('reports per-relay accept/reject and primes the loader only on acceptance', async () => {
    svc.pool = {
      ensureRelay: async (url: string) => ({
        url,
        onnotice: () => undefined,
        publish: async () => {
          if (url.includes('reject')) throw new Error('blocked: not welcome');
        },
      }),
    };
    const loader = (clientService as unknown as { replaceableEventLoader: { prime: (e: Event) => void } })
      .replaceableEventLoader;
    const primeSpy = jest.spyOn(loader, 'prime');

    const kind0: Event = { ...event, kind: 0, id: 'f'.repeat(64) };
    const results = await clientService.publishEvent(kind0, [
      'ws://accept.test',
      'ws://reject.test',
    ]);
    expect(results).toEqual({ 'ws://accept.test': true, 'ws://reject.test': false });
    expect(primeSpy).toHaveBeenCalledTimes(1); // write-through on partial acceptance

    primeSpy.mockClear();
    svc.pool = {
      ensureRelay: async (url: string) => ({
        url,
        onnotice: () => undefined,
        publish: async () => {
          throw new Error('blocked');
        },
      }),
    };
    const allFail = await clientService.publishEvent(kind0, ['ws://reject.test']);
    expect(allFail).toEqual({ 'ws://reject.test': false });
    expect(primeSpy).not.toHaveBeenCalled(); // a fully failed publish never primes
  });
});

describe('publishEvent write containment', () => {
  it('rejects a publish with no relay list', async () => {
    await expect(clientService.publishEvent(event)).rejects.toThrow(
      'explicit relay list'
    );
  });

  it('rejects a publish with an empty relay list', async () => {
    await expect(clientService.publishEvent(event, [])).rejects.toThrow(
      'explicit relay list'
    );
  });
});
