# p-shed — a quota/overload skip must not consume the job's slot

Source brief: `docs/requests/05-pshed-skip-consumes-sparse-slot.md`
Found in production 2026-08-04 on p-shed 0.11.0, within half an hour of enabling speed
profiles. Not caused by the profile feature — exposed by it.

## The defect

`lib/tick.mjs` classifies a Claude usage-limit / transient API overload as a **skip**: the
breaker and the failure counter are deliberately left untouched, because the classifier
has just declared the failure external. The same branch then writes `lastRun: now`:

```js
const next = { ...prev, lastRun: now, lastExit: r.exit, pid: null, lastSkipReason: reason, lastSkipAt: now };
```

`isDue` computes from `lastRun`, so advancing it consumes the slot. The measured case: the
`strategist` job launched at 09:05, came back `api-overload`, and its schedule under the
active profile is `20 6 * * *` — the next slot was **the following morning**. A transient
API blip cost a full day.

The comment on that branch promises *"the next tick retries"*. That is true for a minutely
job and false for a sparse one. It was written when every job ran often; speed profiles
make sparse schedules ordinary, so the gap is now reachable by design.

The failure is also silent in the way that matters. `status` renders `lastSkip:
api-overload`, which reads as "it was skipped" — not as "it will not run again for 23
hours", which is the one an operator would act on.

## What was verified before designing, not assumed

| Claim | Where | Verdict |
|---|---|---|
| `isDue` returns on the FIRST matching minute in its window | `cron.mjs:49-58` | true — catch-up never fires once per missed slot |
| `isDue` clamps its window to `now - 24h` | `cron.mjs:51` | true — catch-up beyond a day is already impossible |
| `lastSkipResetAt` is a usable timestamp | `classify.mjs:214-218` | **false** — `parseResetAt` returns matched free TEXT ("3am"), documented as "purely informational; scheduling is unaffected" |
| the skip branch leaves the breaker alone | `tick.mjs:172-186` | true — and must stay that way |

The third row is the one that shapes the work: "use `lastSkipResetAt`" from the brief
requires a new text→timestamp parse that does not exist yet.

## Design

Two new optional fields in `state/<id>.json`, absent from every existing file:

| field | meaning |
|---|---|
| `retryNotBefore` | epoch ms; the job stays due but must not relaunch before this moment |
| `consecutiveSkips` | how many quota/overload skips in a row — drives the backoff |

### Flow

```
                 due?  ──no──▶ not-due
                  │yes
                  ▼
        retryNotBefore in the future? ──yes──▶ skipped-retry-wait
                  │no                          (writes nothing, logs nothing)
                  ▼
        group gate ▶ guard ▶ launch
                  │
                  ▼
        classifyRun(exit, out, err)
                  │
    ┌─────────────┼──────────────┐
    │             │              │
 success       failure      usage_limit
    │             │              │
    ▼             ▼              ▼
 lastRun=now   lastRun=now   lastRun UNCHANGED  ← the slot is not consumed
 clear retry   clear retry   consecutiveSkips++
 state         state         retryNotBefore = computeRetryAt(...)
                             breaker untouched (unchanged, load-bearing)
```

The due test becomes:

```js
const due = isDue(parseCron(job.schedule), st.lastRun, now) || st.retryNotBefore != null;
```

The `||` is what makes the promise hold for schedules sparser than daily. Without it a
weekly `0 6 * * 1` job skipped on quota loses its slot the moment the outage passes
`isDue`'s 24-hour clamp — the same defect as the brief's, one order of magnitude worse.
A pending retry is cleared by any real run, so the override can only ever produce one
extra launch.

### The gate's position is load-bearing

After `isDue`, before the concurrency-group gate. After, so a job that is not due anyway
reports `not-due` rather than a misleading "waiting to retry". Before the group gate and
the guard, for the reason already stated in `tick.mjs`: no point running an owner-supplied
guard command for a launch that cannot happen.

It writes **no state and no log row** — same as `not-due` and `skipped-group`. A minutely
job under a 30-minute backoff would otherwise add 30 rows per window to the history, which
is exactly the log-noise policy the quiet-guard path already avoids.

### Backoff — `lib/backoff.mjs`

One small module, one job: given a reason, a parsed reset time and the skip count, say
when the job may try again.

- **`usage-limit` with a parseable reset time** → that time. Clamped to `(now, now + 24h]`
  and floored at `now + base`, so a garbage parse degrades to the ordinary backoff instead
  of pinning the job open.
- **everything else** (`api-overload`, or a subscription limit whose message carried no
  usable time) → `min(60s · 2^(n-1), 30 min)`.

The exponential starts at one minute so a 529 that clears in seconds costs one tick, and
caps at 30 minutes so a genuinely exhausted quota polls twice an hour rather than 60 times.

**Parsing "3am" into a timestamp is a bounded risk, and that is why it is worth doing.**
A wrong guess cannot break scheduling: retrying too early merely produces another skip and
another backoff, and retrying too late is capped at 24 hours. `parseResetTime` therefore
tries `Date.parse` first (accepting only a result inside `(now, now + 48h]` — which
rejects V8's creative readings of bare numbers), then a 12-hour `3am` / `3:30pm` form,
then a 24-hour `15:00` form, resolving each to the next occurrence in local time. Anything
else returns undefined and the exponential path takes over.

### `status` tells the two states apart

`collectStatus` gains `retryNotBefore` and `consecutiveSkips` in the JSON. `formatHuman`
already receives `now`, so it renders the distinction the brief asks for:

| state | `lastSkip` column |
|---|---|
| retry pending | `api-overload retry 09:12` |
| backoff elapsed, will go next tick | `api-overload retry-now` |
| skip recorded, no retry pending | `usage-limit next-slot` |

The third row is also what every **pre-upgrade** state file renders as: those have
`lastSkipReason` and no `retryNotBefore`, and their `lastRun` really was advanced, so
"waiting for its next scheduled slot" is the honest reading. Backwards compatibility and
the new reporting requirement land on the same rendering.

### Clearing

Any path that advances `lastRun` invalidates a pending retry, so all three clear
`retryNotBefore` and `consecutiveSkips`: a real run (success or failure), a quiet guard,
and a guard error. The quiet-guard case keeps `lastSkipReason` — the slot was consumed by
a deliberate decision, so there is nothing to retry, but the skip history is still true
and still worth showing.

Paths that write nothing — paused, breaker-tripped, pid-alive, group-held — leave the
retry state alone. They are transient gates, and the retry outlives them by design.

## Alternatives weighed

**Restore the previous `lastRun` on skip, and nothing else.** Identical state write to the
chosen design, minus the bound. A minutely job then relaunches `claude -p` every 60 s for
the whole five-hour quota window, and a daily job does the same. Fails the brief's second
and fourth acceptance rows outright. Rejected: the bound is the actual work here, not the
`lastRun` write.

**`nextDueOverride`.** A second scheduling authority sitting beside cron + `lastRun`.
Every consumer of "when does this run next" would have to consult both, and the two can
disagree — which is precisely the drift argument that kept speed control inside the
scheduler in brief 03. The brief itself calls it the most state to keep coherent.
Rejected.

**Chosen: leave `lastRun` untouched + `retryNotBefore`.** The state says exactly one new
thing ("not before this moment"), it is derived fresh on every skip, it is cleared by
every path that consumes the slot, and a missing field means the pre-upgrade behaviour.

## Non-goals and accepted limits

- **The breaker does not change.** A quota or overload skip never moves
  `consecutiveFailures` and never trips the breaker. Settled, load-bearing, and pinned by
  a test that survives this change.
- **No new configuration knob.** The backoff constants are built in. The backoff describes
  the API's behaviour, not the job's, so a per-job override would be a knob with no reason
  to differ between jobs. `defaults.usageLimitPattern` already exists for the one thing
  that genuinely varies.
- **A permanently exhausted quota retries at the cap forever.** That follows directly from
  "this is not the job's fault", which is the settled rule. `status` shows
  `consecutiveSkips` climbing, which is the signal an operator acts on.
- **`pshed run <id>` stays stateless** and is not gated by `retryNotBefore`. A manual run
  is an operator override.

## Acceptance

Mapped from the brief, one test each:

| case | expected |
|---|---|
| daily job skipped on `usage_limit` at 09:05 | `lastRun` unchanged; due again after the reset time, not tomorrow |
| daily job skipped on `api-overload` | retried under the bounded backoff |
| minutely job skipped on `usage_limit` with a reset time | does not relaunch before that time |
| minutely job skipped on `api-overload` | backs off; does not spin every 60 s |
| job skipped, then succeeds | retry state cleared, schedule normal from that run |
| long outage spanning many slots | exactly one run when it clears |
| `status` after a skip | distinguishes retry-pending from waiting-for-next-slot |
| breaker after any number of skips | untouched |
| pre-upgrade state file | behaves exactly as it does today |

## Verification

`.claude/CLAUDE.md` applies: implemented on Windows, so the e2e suites also run under WSL
and both platforms' numbers are reported. The relevant p-shed suites are `tick*`,
`status*`, `cron`, `cli-e2e` and the new `backoff` unit tests.
