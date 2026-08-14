/**
 * Tests for the structured logging helpers.
 *
 * These helpers wrap console.error/warn with grep-friendly prefixes
 * so log consumers can filter process output efficiently.
 */

import {
  logRelayError,
  logRelayTimeout,
  logRelayConnected,
  logRelayNotice,
  logRelayClosed,
  logRelayReq,
  logNetworkError,
  RELAY_ERROR_PREFIX,
  RELAY_TIMEOUT_PREFIX,
  RELAY_CONNECTED_PREFIX,
  RELAY_NOTICE_PREFIX,
  RELAY_CLOSED_PREFIX,
  RELAY_REQ_PREFIX,
  NETWORK_ERROR_PREFIX,
} from './structured-log';

let consoleErrorSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;
let consoleDebugSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleDebugSpy.mockRestore();
});

describe('structured-log', () => {
  describe('logRelayError', () => {
    it('should log with [RELAY_ERROR] prefix', () => {
      logRelayError('wss://relay.test', 'connection refused');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_ERROR_PREFIX),
        expect.stringContaining('wss://relay.test'),
        expect.stringContaining('connection refused')
      );
    });

    it('should include a timestamp', () => {
      logRelayError('wss://r.test', 'fail');

      const call = consoleWarnSpy.mock.calls[0][0];
      // Should contain ISO-like timestamp
      expect(call).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle Error objects as reason', () => {
      const err = new Error('socket closed');
      logRelayError('wss://r.test', err);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_ERROR_PREFIX),
        expect.stringContaining('wss://r.test'),
        expect.stringContaining('socket closed')
      );
    });
  });

  describe('logRelayTimeout', () => {
    it('should log with [RELAY_TIMEOUT] prefix', () => {
      logRelayTimeout('wss://slow.relay', 30000);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_TIMEOUT_PREFIX),
        expect.stringContaining('wss://slow.relay'),
        expect.stringContaining('30000')
      );
    });
  });

  describe('logRelayConnected', () => {
    it('should log with [RELAY_CONNECTED] prefix', () => {
      logRelayConnected('wss://fast.relay', 150);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_CONNECTED_PREFIX),
        expect.stringContaining('wss://fast.relay'),
        expect.stringContaining('150')
      );
    });
  });

  describe('logRelayNotice', () => {
    it('should log with [RELAY_NOTICE] prefix', () => {
      logRelayNotice('wss://relay.test', 'rate limited: too many concurrent REQs');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_NOTICE_PREFIX),
        expect.stringContaining('wss://relay.test'),
        expect.stringContaining('too many concurrent REQs')
      );
    });
  });

  describe('logRelayClosed', () => {
    it('should log with [RELAY_CLOSED] prefix', () => {
      logRelayClosed('wss://relay.test', 'error: subscription limit reached');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_CLOSED_PREFIX),
        expect.stringContaining('wss://relay.test'),
        expect.stringContaining('subscription limit reached')
      );
    });

    it('should handle Error objects as reason', () => {
      logRelayClosed('wss://relay.test', new Error('relay connection errored'));

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_CLOSED_PREFIX),
        expect.stringContaining('wss://relay.test'),
        expect.stringContaining('relay connection errored')
      );
    });
  });

  describe('logRelayReq', () => {
    it('logs outgoing REQs at debug level with prefix, relay, and filter summary', () => {
      logRelayReq('wss://relay.example.com', 'kinds=0 authors x5');

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining(RELAY_REQ_PREFIX),
        'wss://relay.example.com',
        'kinds=0 authors x5'
      );
    });
  });

  describe('logNetworkError', () => {
    it('should log with [NETWORK_ERROR] prefix', () => {
      logNetworkError('fetchProfile', 'timeout after 45000ms');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(NETWORK_ERROR_PREFIX),
        expect.stringContaining('fetchProfile'),
        expect.stringContaining('timeout after 45000ms')
      );
    });

    it('should handle Error objects', () => {
      logNetworkError('publishEvent', new Error('network down'));

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(NETWORK_ERROR_PREFIX),
        expect.stringContaining('publishEvent'),
        expect.stringContaining('network down')
      );
    });
  });
});
