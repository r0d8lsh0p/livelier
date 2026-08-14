import {
  recordReqOpened,
  recordReqClosed,
  getOpenSubCounts,
  flushRelayReqStatsNow,
  resetRelayReqStatsForTesting,
} from './relay-req-stats';
import { RELAY_REQ_RATE_PREFIX } from './structured-log';

describe('relay-req-stats', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRelayReqStatsForTesting();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    resetRelayReqStatsForTesting();
  });

  it('tracks the open-subscription gauge per relay', () => {
    recordReqOpened('wss://a', 'kinds=0 authors x2');
    recordReqOpened('wss://a', 'kinds=30311');
    recordReqOpened('wss://b', 'kinds=1');

    expect(getOpenSubCounts().get('wss://a')).toBe(2);
    expect(getOpenSubCounts().get('wss://b')).toBe(1);

    recordReqClosed('wss://a');
    expect(getOpenSubCounts().get('wss://a')).toBe(1);

    recordReqClosed('wss://a');
    recordReqClosed('wss://b');
    expect(getOpenSubCounts().size).toBe(0);
  });

  it('never drives the gauge negative on unbalanced closes', () => {
    recordReqClosed('wss://a');
    expect(getOpenSubCounts().size).toBe(0);
  });

  it('flushes one rate line per relay with counts by filter summary', () => {
    recordReqOpened('wss://a', 'kinds=0 authors x2');
    recordReqOpened('wss://a', 'kinds=0 authors x2');
    recordReqOpened('wss://a', 'kinds=30311');

    flushRelayReqStatsNow();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0].join(' ');
    expect(line).toContain(RELAY_REQ_RATE_PREFIX);
    expect(line).toContain('wss://a');
    expect(line).toContain('3 REQs/min');
    expect(line).toContain('kinds=0 authors x2 ×2');
    expect(line).toContain('kinds=30311 ×1');
  });

  it('windows reset after a flush', () => {
    recordReqOpened('wss://a', 'kinds=1');
    flushRelayReqStatsNow();
    logSpy.mockClear();

    flushRelayReqStatsNow();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
