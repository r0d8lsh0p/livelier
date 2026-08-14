/**
 * Exponential retry cooldown for profile fetches that returned no profile.
 *
 * Some users genuinely have no kind-0 profile event, and the relay layer does
 * not cache negative results — so without a cooldown, chat panels would
 * re-query the relays for the same missing profile on every incoming message.
 * The cooldown doubles per failed attempt (30s, 1m, 2m, 4m) and caps at
 * 5 minutes.
 *
 * A miss is NEVER terminal: relays deliver partial results (rate-limit
 * cooldowns, sharded aggregators dropping authors from batch answers, cold
 * sockets missing the deadline), so an empty answer is not proof of
 * absence. Unresolved pubkeys re-coalesce with the next due dispatch —
 * still-wanted misses cost at most one author in one batched REQ per
 * 5-minute cap. PROFILE_RETRY_MAX_ATTEMPTS marks the SLOW-LANE threshold:
 * past it the pubkey is persisted to the negative cache so the next
 * session starts at the capped cadence instead of a fresh fast ladder —
 * it does not stop retries.
 */
export type FailedProfileFetch = { attempts: number; nextRetryAt: number };

export const PROFILE_RETRY_BASE_MS = 30_000;
export const PROFILE_RETRY_MAX_MS = 5 * 60_000;
export const PROFILE_RETRY_MAX_ATTEMPTS = 6;
/**
 * Retry times are rounded UP to the next multiple of this bucket so pubkeys
 * that failed at slightly different moments come due together and retry as
 * ONE batched REQ. Unquantized cooldowns desynchronize into a drip of
 * 1-2-author REQs ("authors x2") — exactly what relay rate limiters punish.
 */
export const PROFILE_RETRY_BUCKET_MS = 30_000;

/**
 * True when a pubkey has reached the slow-lane threshold: retries continue
 * at the capped cadence, but the miss is persisted so the next session
 * starts slow, and boot fast-retry lanes skip it.
 */
export function hasExhaustedProfileRetries(
  failure: FailedProfileFetch | undefined,
): boolean {
  return failure !== undefined && failure.attempts >= PROFILE_RETRY_MAX_ATTEMPTS;
}

export function recordFailedProfileFetch(
  failures: Map<string, FailedProfileFetch>,
  pubkey: string,
  now: number = Date.now()
): FailedProfileFetch {
  const attempts = (failures.get(pubkey)?.attempts ?? 0) + 1;
  const delay = Math.min(PROFILE_RETRY_BASE_MS * 2 ** (attempts - 1), PROFILE_RETRY_MAX_MS);
  const nextRetryAt =
    Math.ceil((now + delay) / PROFILE_RETRY_BUCKET_MS) * PROFILE_RETRY_BUCKET_MS;
  const failure = { attempts, nextRetryAt };
  failures.set(pubkey, failure);
  return failure;
}
