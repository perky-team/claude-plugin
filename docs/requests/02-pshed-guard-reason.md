# Brief 02 — record why a guard said no

Repo: `C:\projects\perky.team\claude-plugin`, plugin `plugins/p-shed/`.

## Why

In `lib/tick.mjs`, a guard that exits 75 is handled like this (current code):

```js
if (g.outcome === 'quiet') {
  // Log-noise policy: quiet is state-only (lastGuard) — no history line. A
  // minutely chat job must not write 1440 quiet records/day; freshness is
  // visible via status.lastGuard instead.
  d.writeJobState(root, job.id, { ...prevG, lastRun: now, lastGuard, consecutiveGuardFailures: 0 });
  results.push({ id: job.id, action: 'guard-quiet' });
  continue;
}
```

where `lastGuard = { at: now, outcome: g.outcome, exit: g.exit }`.

The no-history-row decision is **correct and must stay** — a minutely job would otherwise
write 1440 rows a day. But `g.out` is captured and then thrown away, and that is the part
worth fixing: the guard's own explanation of its decision exists, and nothing keeps it.

The consequence: "why did the worker not run at 14:00?" has no answer anywhere. Not in
`pshed status` (which shows `quiet 40s ago` and nothing more), not in the history log (which
by design has no row). This gets worse as guards get composed — `guard: a && b` is the
supported way to combine conditions, and when the slot goes quiet there is no way to tell
which link said no.

## What to build

Capture a short reason from the guard's stdout and surface it.

### Capture

- Take the **last non-empty line** of the guard's stdout. Last, not first: a shell chain
  `a && b` prints in order, so the last line comes from the command that actually decided.
- Trim it, collapse internal whitespace to single spaces, and cap at ~120 characters.
- Store as `lastGuard.reason`. Omit the field entirely when the result is empty — do not
  store `""`.
- Apply to **all three outcomes** (`pass`, `quiet`, `error`), not just quiet. A guard that
  passed can usefully say why, and an errored one usually printed the failure.

### Surface

In `lib/status.mjs`, `formatHuman` currently renders the guard column as (lines 87–89):

```js
    const guard = j.lastGuard
      ? `${j.lastGuard.outcome} ${Math.max(0, Math.round((now - j.lastGuard.at) / 1000))}s ago`
      : '-';
```

Extend to `quiet 40s ago (нет задач)` when a reason is present.

**The row must stay a single line.** `formatHuman` is a tab-separated table and a newline in
a cell splits it into a fake row. The same file already solves this for `pauseReason` with
`String(...).replace(/\s+/g, ' ').trim()` — follow that precedent rather than inventing a
second approach.

### Do not

- Do not add a history row for quiet slots. The existing policy is deliberate.
- Do not store the full stdout. It is capped at 64 KB in `runGuard`; keeping it in the state
  file would make a per-tick JSON write unboundedly large.

## Acceptance

Tests in `tick-guard.test.ts` and `status-guard.test.ts`:

| case | expected |
|---|---|
| guard exits 75 printing one line | `lastGuard.reason` holds that line |
| guard exits 0 printing one line | reason recorded too |
| guard errors printing one line | reason recorded too |
| stdout has several lines | last non-empty line wins |
| stdout empty / whitespace only | field absent, not `""` |
| single line of 5 KB | truncated to the cap |
| stdout contains `\n` mid-message | human table stays one row per job |
| no reason present | human output unchanged from today |

Bump `plugins/p-shed/.claude-plugin/plugin.json#version` (minor: additive) and mention the
field in `description`.

## Constraints

- `.claude/CLAUDE.md` applies — WSL run of the e2e suites if implemented on Windows, both
  platforms' numbers reported.
- The guard exit-code contract does not change: 0 launch, 75 quiet, else breaker-counted
  error. Live jobs depend on exactly this.
- No release tag or push without explicit confirmation.
