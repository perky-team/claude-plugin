# Brief 05 — a quota/overload skip silently costs a sparse job its whole slot

Repo: `C:\projects\perky.team\claude-plugin`, plugin `plugins/p-shed/`.
Found in production on 2026-08-04, on p-shed 0.11.0, within half an hour of enabling speed
profiles. Not caused by the profile feature — exposed by it.

## What happened

The `strategist` job launched at 09:05, and the run came back classified `api-overload`.
`lib/tick.mjs` handles that correctly as far as the breaker is concerned:

```js
if (outcome === 'usage_limit') {
  // Quota/infra, not a code failure: do NOT touch the failure counter or breaker.
  // Record the skip so `status` can show a stuck-on-limit job; the next tick retries.
  const next = { ...prev, lastRun: now, lastExit: r.exit, pid: null, lastSkipReason: reason, lastSkipAt: now };
```

Measured state afterwards:

```json
{ "lastRun": 1785823501997, "lastExit": 1, "lastSkipReason": "api-overload" }
```

`lastRun` = 09:05. The job's schedule under the active profile is `20 6 * * *`. `isDue`
computes from `lastRun`, so **the next slot is tomorrow at 06:20** — a transient API blip
cost this job a full day.

The comment's promise, *"the next tick retries"*, is true for a minutely job and false for
a sparse one. It was written when every job in this scheduler ran often; speed profiles make
sparse schedules ordinary, so the gap is now reachable by design rather than by accident.

## Why it is worth fixing rather than accepting

The skip path exists precisely to say **"this was not the job's fault."** It already proves
that by refusing to touch the failure counter or the breaker. Advancing `lastRun` contradicts
the same judgement: the job is punished with a lost slot for something the classifier just
declared external.

The failure is also silent in the way that matters. `status` shows `lastSkip: api-overload`,
which reads as "it was skipped", not as "it will not run again for 23 hours". Nothing
distinguishes the two, and the second is the one an operator would act on.

## What to build

Do not consume the slot on a quota/overload skip. The obvious shape is to leave `lastRun`
alone so the job stays due and the next tick retries — genuinely, for every schedule
density, which is what the comment already claims.

Three things that shape have to answer, and they are the actual work:

1. **A minutely job must not hammer a quota that is known to be exhausted.** The state
   already carries `lastSkipResetAt` parsed from the limit message. Use it: stay due, but do
   not relaunch before the reset time. For `api-overload`, which carries no reset time, a
   bounded backoff is needed instead — and it should be visible in `status`, not implicit.
2. **`status` must be able to say which of the two states a job is in** — "retrying, blocked
   until HH:MM" versus "waiting for its next scheduled slot". Today both render as
   `lastSkip: <reason>`.
3. **Catch-up must not stampede.** A job that stays due through a long outage must run once
   when the outage clears, not once per missed slot. Check what `isDue` does with a stale
   `lastRun` before choosing the shape.

Weigh at least these alternatives and justify the choice rather than taking the first:
leaving `lastRun` untouched plus a `retryNotBefore` field; restoring the *previous* `lastRun`
on skip; or a separate `nextDueOverride`. The third is the most explicit and the most state
to keep coherent.

## Acceptance

| case | expected |
|---|---|
| daily job skipped on `usage_limit` at 09:05 | still due after the reset time; does not wait for tomorrow |
| daily job skipped on `api-overload` | retried under a bounded backoff, not once a day |
| minutely job skipped on `usage_limit` with a reset time | does not relaunch before that time |
| minutely job skipped on `api-overload` | backs off; does not spin every 60 s |
| job skipped, then succeeds | skip state cleared, schedule back to normal from that run |
| long outage spanning many slots | exactly one run when it clears, not one per missed slot |
| `status` after a skip | distinguishes "retry pending until HH:MM" from "waiting for next slot" |
| breaker after any number of skips | untouched — this must not regress |

Bump `plugin.json#version` and note the behaviour change in `description`.

## Constraints

- `.claude/CLAUDE.md` applies — WSL run of the e2e suites if implemented on Windows, both
  platforms' numbers reported.
- **The breaker semantics must not change.** A quota or overload skip is not a failure and
  must never move `consecutiveFailures` or trip the breaker. That is settled and load-bearing.
- Backwards compatible with existing `state/<id>.json` files, which have none of the new
  fields.

---

# Appendix — cosmetic, fold in only if it costs nothing

`lastGuard.reason` (brief 02) takes the last line of the guard's stdout, which is right. But
p-chat's guard prints JSON, so on the live board the column now reads:

```
chat-responder   quiet 17s ago ({"action":"guard","result":"quiet","confirmed":626988170})
chat-session-clean quiet 1952s ago ({"action":"reset","file":"/home/andrey/.../session.md"})
```

Nothing is broken — the guard works and the reason is faithfully recorded. It is just that
p-chat predates the feature and has no human-readable line to offer. If p-chat's `guard`
gains a short plain-text line on stdout (JSON staying behind `--json`, as `ptasks guard`
already does), the column becomes readable. Purely presentational; not worth a release on
its own.
