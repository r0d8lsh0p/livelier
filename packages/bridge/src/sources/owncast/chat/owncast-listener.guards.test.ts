import { EventEmitter } from 'events';
import type { Logger } from 'pino';

/**
 * One fake socket per dial, so a test can count attempts and drive each
 * connection's outcome by hand.
 */
const fakeSockets: FakeSocket[] = [];

class FakeSocket extends EventEmitter {
  closed = false;
  constructor(readonly url: string) {
    super();
    fakeSockets.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string) => new FakeSocket(url)),
}));

import { OwncastChatListener } from './owncast-listener';

const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

const { MAX_CONSECUTIVE_FAILURES, DORMANT_INTERVAL_MS, MIN_HEALTHY_CONNECTION_MS } =
  OwncastChatListener;

/**
 * The reachability guards: the `chatDisabled` pre-check and the failure budget
 * that drops a hopeless instance to a slow re-probe. Rooms are
 * established-only and live as long as the stream, so the load-bearing property
 * is that neither guard is terminal — a listener that gave up for good would
 * turn a brief network fault into chat being dead for the rest of a broadcast.
 */
describe('OwncastChatListener reachability guards', () => {
  const REGISTERED = { id: 'self', accessToken: 'tok', displayName: 'Livelier' };

  /** Answer /api/config with `chatDisabled`, and /api/chat/register with a token. */
  function mockEndpoints(opts: { chatDisabled?: boolean; configFails?: boolean } = {}): jest.Mock {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/config')) {
        if (opts.configFails) throw new Error('network down');
        return { ok: true, json: async () => ({ chatDisabled: opts.chatDisabled ?? false }) };
      }
      return { ok: true, json: async () => REGISTERED };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock as unknown as jest.Mock;
  }

  const registerCalls = (f: jest.Mock): number =>
    f.mock.calls.filter(([url]) => String(url).endsWith('/api/chat/register')).length;

  const latest = (): FakeSocket => fakeSockets[fakeSockets.length - 1];

  /** Refuse the newest dial and let the fast backoff run out. */
  async function refuseLatestDial(): Promise<void> {
    latest().emit('close');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
  }

  /** Spend the whole fast-retry budget, leaving the listener dormant. */
  async function exhaustBudget(): Promise<void> {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) await refuseLatestDial();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    fakeSockets.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never dials an instance that reports chatDisabled', async () => {
    const fetchMock = mockEndpoints({ chatDisabled: true });
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);

    await listener.start();

    expect(listener.isDormant).toBe(true);
    expect(registerCalls(fetchMock)).toBe(0);
    expect(fakeSockets).toHaveLength(0);
  });

  it('re-probes a chatDisabled instance, so switching chat back on is picked up', async () => {
    mockEndpoints({ chatDisabled: true });
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    // Nothing happens on the fast cadence — that is the whole point.
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(fakeSockets).toHaveLength(0);

    // The streamer turns chat on; the next slow probe finds it.
    mockEndpoints({ chatDisabled: false });
    await jest.advanceTimersByTimeAsync(DORMANT_INTERVAL_MS);

    expect(fakeSockets).toHaveLength(1);
  });

  it('fails open when the config cannot be read — a blip is not a disable', async () => {
    const fetchMock = mockEndpoints({ configFails: true });
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);

    await listener.start();

    expect(listener.isDormant).toBe(false);
    expect(registerCalls(fetchMock)).toBe(1);
    expect(fakeSockets).toHaveLength(1);
  });

  it('drops to the slow cadence after MAX_CONSECUTIVE_FAILURES', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) await refuseLatestDial();
    expect(fakeSockets).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(listener.isDormant).toBe(false);

    await refuseLatestDial();
    expect(listener.isDormant).toBe(true);
    // The fast cadence is over: no further dial on the old schedule.
    expect(fakeSockets).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });

  it('keeps re-probing once dormant, so a network fault is never terminal', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();
    await exhaustBudget();
    const dialsWhenDormant = fakeSockets.length;

    await jest.advanceTimersByTimeAsync(DORMANT_INTERVAL_MS);
    expect(fakeSockets).toHaveLength(dialsWhenDormant + 1);

    // The instance comes back and the connection holds: dormancy lifts.
    latest().emit('open');
    await jest.advanceTimersByTimeAsync(MIN_HEALTHY_CONNECTION_MS);
    expect(listener.isDormant).toBe(false);

    // ...and the fast cadence is available again.
    latest().emit('close');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(fakeSockets).toHaveLength(dialsWhenDormant + 2);
  });

  it('a connection that drops immediately does not refill the budget', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    // Every attempt completes the upgrade, then dies well before proving itself.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      latest().emit('open');
      await jest.advanceTimersByTimeAsync(MIN_HEALTHY_CONNECTION_MS / 2);
      latest().emit('close');
      await jest.advanceTimersByTimeAsync(5 * 60_000);
    }

    expect(listener.isDormant).toBe(true);
  });

  it('a connection that holds clears the budget, so flakiness never accumulates', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await refuseLatestDial();
    latest().emit('open');
    await jest.advanceTimersByTimeAsync(MIN_HEALTHY_CONNECTION_MS);
    latest().emit('close');
    await jest.advanceTimersByTimeAsync(15_000);

    // A full fresh budget: spending all but one of it must not go dormant.
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) await refuseLatestDial();
    expect(listener.isDormant).toBe(false);
  });

  it('stop() ends the listener for good', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    listener.stop();
    await refuseLatestDial();
    await jest.advanceTimersByTimeAsync(DORMANT_INTERVAL_MS);

    expect(fakeSockets).toHaveLength(1);
  });

  it('stop() during the pre-flight fetches leaves no orphaned socket', async () => {
    let releaseConfig: (() => void) | undefined;
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/config')) {
        await new Promise<void>((resolve) => {
          releaseConfig = resolve;
        });
        return { ok: true, json: async () => ({ chatDisabled: false }) };
      }
      return { ok: true, json: async () => REGISTERED };
    }) as unknown as typeof fetch;

    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    const starting = listener.start();

    // The room closes while the config request is still in flight.
    await Promise.resolve();
    listener.stop();
    releaseConfig?.();
    await starting;

    expect(fakeSockets).toHaveLength(0);
  });
});
