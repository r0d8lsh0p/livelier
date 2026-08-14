const mockStorage = (() => {
  let stored: Record<string, string> = {};
  return {
    reset: () => {
      stored = {};
    },
    get: (key: string) => stored[key] ?? null,
    set: (key: string, value: string) => {
      stored[key] = value;
    },
    del: (key: string) => {
      delete stored[key];
    },
  };
})();

const mockSetItem = jest.fn(async (key: string, value: string) => mockStorage.set(key, value));

jest.mock('../storage/secure-storage.service', () => ({
  __esModule: true,
  default: {
    isAvailable: jest.fn(async () => true),
    getItem: jest.fn(async (key: string) => mockStorage.get(key)),
    setItem: mockSetItem,
    deleteItem: jest.fn(async (key: string) => mockStorage.del(key)),
  },
}));

import profileCacheService from './ProfileCacheService';
import { STORAGE_KEYS } from '../storage/config';

function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('ProfileCacheService', () => {
  beforeEach(async () => {
    mockStorage.reset();
    mockSetItem.mockClear();
    await flushPromises();
  });

  it('removeProfile deletes a stored profile and persists', async () => {
    const pubkey = 'abc';
    profileCacheService.storeProfile(pubkey, { name: 'A', picture: null, timestamp: Date.now() });
    await flushPromises();

    expect(profileCacheService.hasProfile(pubkey)).toBe(true);

    profileCacheService.removeProfile(pubkey);
    await flushPromises();

    expect(profileCacheService.hasProfile(pubkey)).toBe(false);
    const raw = mockStorage.get(STORAGE_KEYS.PROFILE_CACHE);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(pubkey);
  });

  describe('storeProfile debounce', () => {
    it('batches rapid storeProfile calls into a single storage write', async () => {
      jest.useFakeTimers();
      mockSetItem.mockClear();

      // Store 6 profiles in rapid succession (simulating a relay batch)
      for (let i = 0; i < 6; i++) {
        profileCacheService.storeProfile(`batch-${i}`, {
          name: `User ${i}`,
          picture: null,
          timestamp: Date.now(),
        });
      }

      // All 6 should be in-memory immediately
      for (let i = 0; i < 6; i++) {
        expect(profileCacheService.hasProfile(`batch-${i}`)).toBe(true);
      }

      // Advance past the debounce window and flush async
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();

      // Should have exactly 1 storage write for the entire batch of 6 profiles
      expect(mockSetItem).toHaveBeenCalledTimes(1);

      // The single write should contain all 6 profiles
      const lastWriteArgs = mockSetItem.mock.calls[0];
      const written = JSON.parse(lastWriteArgs[1]);
      for (let i = 0; i < 6; i++) {
        expect(written[`batch-${i}`]).toBeDefined();
        expect(written[`batch-${i}`].name).toBe(`User ${i}`);
      }
    });

    it('all profiles are persisted after debounce settles', async () => {
      jest.useFakeTimers();
      mockSetItem.mockClear();

      profileCacheService.storeProfile('settle-a', { name: 'A', picture: null, timestamp: Date.now() });
      profileCacheService.storeProfile('settle-b', { name: 'B', picture: null, timestamp: Date.now() });
      profileCacheService.storeProfile('settle-c', { name: 'C', picture: null, timestamp: Date.now() });

      // Advance past debounce and flush
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();

      // Read what was persisted
      const raw = mockStorage.get(STORAGE_KEYS.PROFILE_CACHE);
      expect(raw).toBeTruthy();
      const persisted = JSON.parse(raw!);
      expect(persisted['settle-a']).toBeDefined();
      expect(persisted['settle-b']).toBeDefined();
      expect(persisted['settle-c']).toBeDefined();
    });

    it('removeProfile flushes to storage immediately, not debounced', async () => {
      jest.useFakeTimers();

      // First store a profile and let it persist
      profileCacheService.storeProfile('to-remove', { name: 'Remove Me', picture: null, timestamp: Date.now() });
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();

      mockSetItem.mockClear();

      // Remove the profile - should save immediately without debounce
      profileCacheService.removeProfile('to-remove');
      await flushPromises();

      expect(mockSetItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAllProfiles', () => {
    it('returns all cached profiles as pubkey/profile entries', () => {
      profileCacheService.storeProfile('pk-a', { name: 'Alice', picture: null, timestamp: Date.now() });
      profileCacheService.storeProfile('pk-b', { name: 'Bob', picture: null, timestamp: Date.now() });

      const entries = profileCacheService.getAllProfiles();
      const byPubkey = Object.fromEntries(entries.map((e) => [e.pubkey, e.profile.name]));

      expect(byPubkey['pk-a']).toBe('Alice');
      expect(byPubkey['pk-b']).toBe('Bob');
    });

    it('omits expired profiles', () => {
      const expired = Date.now() - 31 * 24 * 60 * 60 * 1000; // older than 30d TTL
      profileCacheService.storeProfile('fresh', { name: 'Fresh', picture: null, timestamp: Date.now() });
      profileCacheService.storeProfile('stale', { name: 'Stale', picture: null, timestamp: expired });

      const pubkeys = profileCacheService.getAllProfiles().map((e) => e.pubkey);
      expect(pubkeys).toContain('fresh');
      expect(pubkeys).not.toContain('stale');
    });
  });
});

