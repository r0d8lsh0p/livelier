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

/**
 * The two guards that separate "flaky, keep trying" from "no chat here": the
 * `chatDisabled` pre-check and the consecutive-failure ceiling. Both matter
 * because rooms are established-only — before these, nothing stopped a
 * listener short of the stream itself ending.
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

  /** Refuse the newest dial and let the backoff run out. */
  async function refuseLatestDial(): Promise<void> {
    fakeSockets[fakeSockets.length - 1].emit('close');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
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

    expect(listener.isParked).toBe(true);
    expect(registerCalls(fetchMock)).toBe(0);
    expect(fakeSockets).toHaveLength(0);
  });

  it('fails open when the config cannot be read — a blip is not a disable', async () => {
    const fetchMock = mockEndpoints({ configFails: true });
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);

    await listener.start();

    expect(listener.isParked).toBe(false);
    expect(registerCalls(fetchMock)).toBe(1);
    expect(fakeSockets).toHaveLength(1);
  });

  it('parks after MAX_CONSECUTIVE_FAILURES rather than retrying forever', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    // Every dial is refused. The last attempt inside the budget still redials.
    for (let i = 1; i < OwncastChatListener.MAX_CONSECUTIVE_FAILURES; i++) {
      await refuseLatestDial();
    }
    expect(fakeSockets).toHaveLength(OwncastChatListener.MAX_CONSECUTIVE_FAILURES);
    expect(listener.isParked).toBe(false);

    // One more tips it over the ceiling: parked, and no further socket opened.
    await refuseLatestDial();

    expect(listener.isParked).toBe(true);
    expect(fakeSockets).toHaveLength(OwncastChatListener.MAX_CONSECUTIVE_FAILURES);
  });

  it('a working connection resets the budget, so flakiness never accumulates', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    for (let i = 0; i < OwncastChatListener.MAX_CONSECUTIVE_FAILURES - 1; i++) {
      await refuseLatestDial();
    }
    fakeSockets[fakeSockets.length - 1].emit('open');

    // A full fresh budget is available; spending all but one of it must not park.
    for (let i = 1; i < OwncastChatListener.MAX_CONSECUTIVE_FAILURES; i++) {
      await refuseLatestDial();
    }
    expect(listener.isParked).toBe(false);
  });

  it('stop() ends the listener without marking the instance unreachable', async () => {
    mockEndpoints();
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();

    listener.stop();
    await refuseLatestDial();

    expect(listener.isParked).toBe(false);
    expect(fakeSockets).toHaveLength(1);
  });

  it('start() clears a previous parking, so a returning stream is re-examined', async () => {
    mockEndpoints({ chatDisabled: true });
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    await listener.start();
    expect(listener.isParked).toBe(true);

    // The streamer turns chat back on and goes live again.
    mockEndpoints({ chatDisabled: false });
    await listener.start();

    expect(listener.isParked).toBe(false);
    expect(fakeSockets).toHaveLength(1);
  });
});
