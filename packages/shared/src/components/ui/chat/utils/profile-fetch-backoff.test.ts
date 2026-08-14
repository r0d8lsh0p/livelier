import {
  recordFailedProfileFetch,
  PROFILE_RETRY_BASE_MS,
  PROFILE_RETRY_MAX_MS,
  PROFILE_RETRY_BUCKET_MS,
  FailedProfileFetch,
} from './profile-fetch-backoff';

describe('recordFailedProfileFetch', () => {
  it('schedules the first retry one base delay out, rounded up to the bucket', () => {
    const failures = new Map<string, FailedProfileFetch>();
    const failure = recordFailedProfileFetch(failures, 'pk', 1_000_000);
    expect(failure.attempts).toBe(1);
    const raw = 1_000_000 + PROFILE_RETRY_BASE_MS;
    expect(failure.nextRetryAt).toBe(
      Math.ceil(raw / PROFILE_RETRY_BUCKET_MS) * PROFILE_RETRY_BUCKET_MS
    );
    expect(failures.get('pk')).toEqual(failure);
  });

  it('quantizes retry times so near-simultaneous failures share one cohort', () => {
    const failures = new Map<string, FailedProfileFetch>();
    // Three pubkeys failing seconds apart must come due at the SAME instant,
    // so the retry heartbeat fetches them as one batched REQ instead of a
    // drip of single-author REQs.
    const a = recordFailedProfileFetch(failures, 'a', 1_000_000);
    const b = recordFailedProfileFetch(failures, 'b', 1_004_000);
    const c = recordFailedProfileFetch(failures, 'c', 1_009_000);
    expect(a.nextRetryAt).toBe(b.nextRetryAt);
    expect(b.nextRetryAt).toBe(c.nextRetryAt);
    expect(a.nextRetryAt % PROFILE_RETRY_BUCKET_MS).toBe(0);
  });

  it('doubles the delay per attempt and caps at the maximum', () => {
    const failures = new Map<string, FailedProfileFetch>();
    const now = 0;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      delays.push(recordFailedProfileFetch(failures, 'pk', now).nextRetryAt);
    }
    expect(delays.slice(0, 4)).toEqual([30_000, 60_000, 120_000, 240_000]);
    // 5th attempt onwards is capped at 5 minutes
    expect(delays.slice(4)).toEqual([PROFILE_RETRY_MAX_MS, PROFILE_RETRY_MAX_MS, PROFILE_RETRY_MAX_MS]);
    expect(failures.get('pk')?.attempts).toBe(7);
  });

  it('tracks attempts independently per pubkey', () => {
    const failures = new Map<string, FailedProfileFetch>();
    recordFailedProfileFetch(failures, 'a', 0);
    recordFailedProfileFetch(failures, 'a', 0);
    recordFailedProfileFetch(failures, 'b', 0);
    expect(failures.get('a')?.attempts).toBe(2);
    expect(failures.get('b')?.attempts).toBe(1);
  });
});
