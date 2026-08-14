/**
 * subscribe() lifecycle against a fake pool: EOSE accounting, rate-limit
 * cooldown, and — the load-bearing part — automatic re-subscription after
 * the cooldown lapses, so standing chat firehoses survive rate limiting.
 */
import type { Event, Filter } from 'nostr-tools';
import clientService, { RELAY_COOLDOWN_BASE_MS } from './client.service';

type Handlers = {
  alreadyHaveEvent?: (id: string) => boolean;
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
};

function fakePool() {
  const relays = new Map<string, { handlers: Handlers | null; subscribeCount: number }>();
  const ensureRelay = jest.fn(async (url: string) => {
    let state = relays.get(url);
    if (!state) {
      state = { handlers: null, subscribeCount: 0 };
      relays.set(url, state);
    }
    const s = state;
    return {
      url,
      onnotice: () => undefined,
      subscribe: (_filters: Filter[], handlers: Handlers) => {
        s.handlers = handlers;
        s.subscribeCount++;
        return { close: () => handlers.onclose?.('closed by caller') };
      },
    };
  });
  return { ensureRelay, close: jest.fn(), relays };
}

/** Flush pending microtasks so ensureRelay().then chains settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('clientService.subscribe', () => {
  const svc = clientService as unknown as { pool: unknown };
  let realPool: unknown;

  beforeEach(() => {
    realPool = svc.pool;
  });
  afterEach(() => {
    svc.pool = realPool;
    jest.useRealTimers();
  });

  it('fires oneose(true) once every relay (including failed connections) settles', async () => {
    const pool = fakePool();
    pool.ensureRelay.mockImplementationOnce(async (url: string) => {
      void url;
      throw new Error('connect refused');
    });
    svc.pool = pool;

    const oneose = jest.fn();
    clientService.subscribe(['ws://sub-a.test', 'ws://sub-b.test'], { kinds: [1311] }, { oneose });
    await settle();
    pool.relays.get('ws://sub-b.test')?.handlers?.oneose?.();
    expect(oneose).toHaveBeenCalledWith(true);
  });

  it('re-subscribes after a rate-limit cooldown lapses; caller close cancels the retry', async () => {
    jest.useFakeTimers();
    const pool = fakePool();
    svc.pool = pool;

    const url = 'ws://sub-ratelimit.test';
    const sub = clientService.subscribe([url], { kinds: [1311] }, {});
    await jest.advanceTimersByTimeAsync(0);
    expect(pool.relays.get(url)?.subscribeCount).toBe(1);

    // Relay CLOSEs the standing REQ with a rate-limit reason.
    pool.relays.get(url)?.handlers?.onclose?.('rate-limited: slow down');
    expect(clientService.isRelayCoolingDown(url)).toBe(true);

    // Cooldown lapses → the subscription comes back on its own.
    await jest.advanceTimersByTimeAsync(RELAY_COOLDOWN_BASE_MS + 1000);
    expect(pool.relays.get(url)?.subscribeCount).toBe(2);

    // The retried sub reaching EOSE is answer-evidence: strikes clear, so a
    // future episode starts back at the base cooldown (monorepo rule).
    pool.relays.get(url)?.handlers?.oneose?.();
    expect(clientService.isRelayCoolingDown(url)).toBe(false);
    expect(
      (clientService as unknown as { relayCooldowns: Map<string, unknown> }).relayCooldowns.has(url)
    ).toBe(false);

    // Second episode, then the caller closes: the pending retry must die.
    pool.relays.get(url)?.handlers?.onclose?.('rate-limited: slow down');
    sub.close();
    await jest.advanceTimersByTimeAsync(20 * RELAY_COOLDOWN_BASE_MS);
    expect(pool.relays.get(url)?.subscribeCount).toBe(2);
  });

  it('a non-rate-limit close does not schedule a retry', async () => {
    jest.useFakeTimers();
    const pool = fakePool();
    svc.pool = pool;

    const url = 'ws://sub-plainclose.test';
    clientService.subscribe([url], { kinds: [1311] }, {});
    await jest.advanceTimersByTimeAsync(0);
    pool.relays.get(url)?.handlers?.onclose?.('relay connection closed');
    await jest.advanceTimersByTimeAsync(20 * RELAY_COOLDOWN_BASE_MS);
    expect(pool.relays.get(url)?.subscribeCount).toBe(1);
    expect(clientService.isRelayCoolingDown(url)).toBe(false);
  });
});
