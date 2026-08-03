# Incoming requests — Raspberry Pi autonomous loop, 2026-08-03

Four changes the live p-shed/p-tasks deployment on the Pi needs. Each numbered file is a
**requirement**, not an implementation plan: it states the problem, the measurement behind
it, what to build and how it will be judged. Turning one into steps is your job.

## How to run this

Work the four **in order, one at a time, in this session**:

1. Read the brief.
2. If the change is more than mechanical (03 certainly is), run the repo's normal flow —
   `superpowers:brainstorming` → `superpowers:writing-plans` → implement — and leave the
   spec/plan in `docs/superpowers/`. For a small one (02, probably 04) go straight to
   implementation with tests first.
3. Land it as its own commit, suite green.
4. **Stop before any release tag or push.** Report the proposed monorepo tag and per-plugin
   bumps and wait for an explicit yes, as `.claude/CLAUDE.md` requires.
5. Then start the next brief.

Do not run them in parallel or interleave them. 02, 03 and 04 all touch p-shed and 02/03
both settle in `lib/tick.mjs`.

| # | brief | plugin | size |
|---|---|---|---|
| 01 | [`ptasks guard`](01-ptasks-guard.md) | p-tasks | small, fully independent |
| 02 | [`lastGuard.reason`](02-pshed-guard-reason.md) | p-shed | small |
| 03 | [speed profiles](03-pshed-profiles.md) | p-shed | large — the one that needs a design pass |
| 04 | [`install-cron` path](04-pshed-install-cron-path.md) | p-shed | medium, independent |

## Why these four, and why they are split this way

```
p-shed   ─ the scheduler          → profiles (03), guard reason (02), cron path (04)
   │       it already holds job state, run history and the launch decision
   └─ guard: <shell command>  ← the seam; exists since 0.9.0
         ▲          ▲
p-tasks ─┘ owns the backlog       → `ptasks guard` (01)      ← does not exist yet
p-chat  ─┘ owns the chat          → `pchat guard`            ← already shipped: the precedent
         │
   consumer's own shell script    → only what is true of exactly ONE repository
```

The rule that produced the split: **a guard belongs to the plugin that owns the data it
reads.** p-chat already demonstrates it. Anything left over that is specific to a single
repository stays in a shell script on the consumer's side and does not enter a plugin.

Worth stating because it was actively considered and rejected: implementing speed control
(03) as an external guard that rate-limits by writing its own `lastrun` stamp files. That
re-implements scheduler state outside the scheduler, and the two copies drift. Scheduling
belongs in the scheduler.

## Verified state at the time of writing

Checked against this checkout, not assumed:

| | |
|---|---|
| `plugins/p-shed/.claude-plugin/plugin.json` | `0.10.0` |
| `plugins/p-tasks/.claude-plugin/plugin.json` | `1.1.4` |
| `plugins/p-chat/.claude-plugin/plugin.json` | `0.1.3` |
| p-tasks `KNOWN` | `['init','add','set','next','summary','list','sync']` — no `guard` |
| p-chat `KNOWN` | `['init','guard','pending','ack','send','reset','status']` — has one |
| p-chat `GUARD_QUIET` | `75`, `pchat.mjs:27` |

Note for anyone reasoning about the deployed side: the Pi is **behind this checkout** — it
runs p-tasks 1.1.3 and p-chat 0.1.1. Do not assume a version bump here is live there.

## Shared constraints

- `.claude/CLAUDE.md` applies in full. In particular: **implemented on Windows means the
  e2e suites must also run under WSL, with both platforms' numbers reported.** That rule
  exists because `describe.skipIf(win32)` tests are verified nowhere otherwise, and it has
  already caught four tests red on Linux while green on Windows.
- Bump `plugins/<name>/.claude-plugin/plugin.json#version` and extend its `description`
  wherever a command or config key is added. The marketplace cache is keyed on that version:
  source shipped without a bump leaves users on the old code.
- **The guard contract does not change**: exit `0` launch, `75` quiet skip (not a failure,
  no history row), anything else or a timeout is an error counted toward the breaker. Live
  jobs depend on exactly this.
- Backwards compatibility is not optional. There are running installations whose `jobs.yml`
  has none of the new keys, and they must behave exactly as they do today.
