// When may a job that was skipped for quota/overload try again?
//
// A quota/overload skip does NOT consume the job's slot (see tick.mjs): `lastRun` is left
// alone, so the job stays due. That fixes the sparse-schedule defect — a `20 6 * * *` job
// that hit a transient 529 at 09:05 no longer waits until tomorrow — but on its own it
// would make a minutely job relaunch `claude -p` every 60 s for a whole five-hour quota
// window. This module is the bound: one function, one question, no state of its own.
//
// The reason a reset time may override the exponent at all is that being wrong is cheap.
// Retrying too early merely produces another skip and a longer backoff; retrying too late
// is clamped. That asymmetry is what makes a best-effort parse of a human message
// ("resets 3am") acceptable input to a scheduling decision.

export const SKIP_BACKOFF_BASE_MS = 60_000;          // one tick — a 529 often clears that fast
export const SKIP_BACKOFF_MAX_MS = 30 * 60_000;      // an exhausted quota polls twice an hour
const MAX_DEFERRAL_MS = 24 * 60 * 60_000;            // no parse may pin a job open longer

/**
 * -> epoch ms, always strictly in the future.
 *
 * `consecutiveSkips` is 1-based (the first skip passes 1). A known `resetAtMs` wins over
 * the exponent in BOTH directions: further away, because the quota is genuinely gone
 * until then; closer, because there is no reason to sit out an exponent the API has
 * already stopped enforcing. It is floored at one tick and capped at a day, so a reset
 * time in the past, at `now`, or absurdly far away all degrade to something sane instead
 * of wedging the job.
 */
export function computeRetryAt({ now, consecutiveSkips = 1, resetAtMs = undefined }) {
  const n = Math.max(1, Number(consecutiveSkips) || 1);
  const exponential = Math.min(SKIP_BACKOFF_BASE_MS * 2 ** (n - 1), SKIP_BACKOFF_MAX_MS);
  const floor = now + SKIP_BACKOFF_BASE_MS;
  if (resetAtMs == null || !Number.isFinite(resetAtMs)) return now + exponential;
  return Math.max(floor, Math.min(resetAtMs, now + MAX_DEFERRAL_MS));
}
