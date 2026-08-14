import { FingerprintCache } from './fingerprint';

describe('FingerprintCache', () => {
  it('remembers a fingerprint within the TTL', () => {
    const cache = new FingerprintCache(60_000);
    const key = FingerprintCache.key('alice', 'hello');
    expect(cache.has(key)).toBe(false);
    cache.add(key);
    expect(cache.has(key)).toBe(true);
  });

  it('expires after the TTL', () => {
    jest.useFakeTimers();
    const cache = new FingerprintCache(1000);
    const key = FingerprintCache.key('alice', 'hello');
    cache.add(key);
    jest.advanceTimersByTime(1500);
    expect(cache.has(key)).toBe(false);
    jest.useRealTimers();
  });

  it('distinguishes name and content combinations', () => {
    expect(FingerprintCache.key('a', 'b')).not.toBe(FingerprintCache.key('b', 'a'));
  });
});
