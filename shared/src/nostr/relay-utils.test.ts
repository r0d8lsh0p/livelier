import { Event } from 'nostr-tools';
import {
  normalizeUrl,
  getRelayListFromRelayListEvent,
  getDefaultReadRelays,
  getDefaultWriteRelays,
  RelayList,
} from './relay-utils';
import { initAppConfig } from '../config/app-config';

describe('relay-utils', () => {
  describe('normalizeUrl', () => {
    it('should add wss:// prefix if missing', () => {
      expect(normalizeUrl('relay.damus.io')).toBe('wss://relay.damus.io');
      expect(normalizeUrl('purplepag.es')).toBe('wss://purplepag.es');
    });

    it('should preserve existing wss:// prefix', () => {
      expect(normalizeUrl('wss://relay.damus.io')).toBe('wss://relay.damus.io');
    });

    it('should preserve existing ws:// prefix', () => {
      expect(normalizeUrl('ws://localhost:7777')).toBe('ws://localhost:7777');
    });

    it('should remove trailing slashes', () => {
      expect(normalizeUrl('wss://relay.damus.io/')).toBe('wss://relay.damus.io');
      expect(normalizeUrl('wss://relay.damus.io///')).toBe('wss://relay.damus.io');
      expect(normalizeUrl('relay.damus.io/')).toBe('wss://relay.damus.io');
    });

    it('should return null for invalid URLs', () => {
      expect(normalizeUrl('')).toBe(null);
      expect(normalizeUrl('not a valid url :::')).toBe(null);
    });
  });

  describe('getRelayListFromRelayListEvent', () => {
    it('should return null when event is undefined (no defaults)', () => {
      const result = getRelayListFromRelayListEvent(undefined);

      expect(result).toBeNull();
    });

    it('should parse relays with read type (empty write array, no defaults)', () => {
      const event = createRelayListEvent([
        ['r', 'wss://relay.damus.io', 'read'],
        ['r', 'wss://purplepag.es', 'read'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toContain('wss://relay.damus.io');
      expect(result!.read).toContain('wss://purplepag.es');
      expect(result!.write).toEqual([]); // Empty, no defaults injected
    });

    it('should parse relays with write type (empty read array, no defaults)', () => {
      const event = createRelayListEvent([
        ['r', 'wss://relay.damus.io', 'write'],
        ['r', 'wss://nos.lol', 'write'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.write).toContain('wss://relay.damus.io');
      expect(result!.write).toContain('wss://nos.lol');
      expect(result!.read).toEqual([]); // Empty, no defaults injected
    });

    it('should add relays without type to both read and write', () => {
      const event = createRelayListEvent([
        ['r', 'wss://relay.damus.io'],
        ['r', 'wss://nos.lol'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toContain('wss://relay.damus.io');
      expect(result!.read).toContain('wss://nos.lol');
      expect(result!.write).toContain('wss://relay.damus.io');
      expect(result!.write).toContain('wss://nos.lol');
    });

    it('should handle mixed relay types', () => {
      const event = createRelayListEvent([
        ['r', 'wss://read-only.relay', 'read'],
        ['r', 'wss://write-only.relay', 'write'],
        ['r', 'wss://both.relay'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toContain('wss://read-only.relay');
      expect(result!.read).toContain('wss://both.relay');
      expect(result!.read).not.toContain('wss://write-only.relay');

      expect(result!.write).toContain('wss://write-only.relay');
      expect(result!.write).toContain('wss://both.relay');
      expect(result!.write).not.toContain('wss://read-only.relay');
    });

    it('should skip invalid URLs', () => {
      const event = createRelayListEvent([
        ['r', 'wss://valid.relay'],
        ['r', 'https://invalid.relay'],
        ['r', 'not-a-url'],
        ['r', ''],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toContain('wss://valid.relay');
      expect(result!.write).toContain('wss://valid.relay');
      expect(result!.read.length).toBe(1);
      expect(result!.write.length).toBe(1);
    });

    it('should normalize URLs', () => {
      const event = createRelayListEvent([
        ['r', 'wss://relay.damus.io/'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toContain('wss://relay.damus.io');
      expect(result!.read).not.toContain('wss://relay.damus.io/');
    });

    it('should ignore non-r tags', () => {
      const event = createRelayListEvent([
        ['r', 'wss://relay.damus.io'],
        ['p', 'somepubkey'],
        ['e', 'someeventid'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toEqual(['wss://relay.damus.io']);
      expect(result!.write).toEqual(['wss://relay.damus.io']);
    });

    it('should return empty arrays (not defaults) when event has no r tags', () => {
      const event = createRelayListEvent([
        ['p', 'somepubkey'],
        ['e', 'someeventid'],
      ]);

      const result = getRelayListFromRelayListEvent(event);

      expect(result).not.toBeNull();
      expect(result!.read).toEqual([]);
      expect(result!.write).toEqual([]);
    });
  });

  describe('getter functions reflect initAppConfig overrides', () => {
    afterEach(() => {
      // Reset to production defaults after each test
      initAppConfig();
    });

    it('getDefaultReadRelays reflects overrides set via initAppConfig', () => {
      const custom = ['wss://custom-read-1.test', 'wss://custom-read-2.test'];
      initAppConfig({ defaultReadRelays: custom });

      expect(getDefaultReadRelays()).toEqual(custom);
    });

    it('getDefaultWriteRelays reflects overrides set via initAppConfig', () => {
      const custom = ['wss://custom-write.test'];
      initAppConfig({ defaultWriteRelays: custom });

      expect(getDefaultWriteRelays()).toEqual(custom);
    });

    it('getters return production defaults when initAppConfig not called', () => {
      initAppConfig(); // reset
      expect(getDefaultReadRelays().length).toBeGreaterThan(0);
      // purplepag.es serves profile lookups only — never the general read set.
      expect(getDefaultReadRelays()).not.toContain('wss://purplepag.es');
      expect(getDefaultWriteRelays()).toContain('wss://relay.nostr.net');
      // relay.damus.io shut down July 2026 — must not resurface in any default
      expect(getDefaultWriteRelays()).not.toContain('wss://relay.damus.io');
      expect(getDefaultReadRelays()).not.toContain('wss://relay.damus.io');
    });
  });
});

// Helper function to create a relay list event for testing
function createRelayListEvent(tags: string[][]): Event {
  return {
    id: 'test-event-id',
    pubkey: 'test-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: 10002,
    tags,
    content: '',
    sig: 'test-signature',
  };
}
