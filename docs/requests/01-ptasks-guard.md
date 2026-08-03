# Brief 01 — add a `guard` command to p-tasks

Repo: `C:\projects\perky.team\claude-plugin`, plugin `plugins/p-tasks/`.

## Why

p-shed lets any job put a cheap shell command in front of the expensive `claude -p` launch:

- exit `0` → launch
- exit `75` → deliberately quiet, no work this slot (not a failure, no history row)
- anything else / timeout → guard error, counted toward the job's circuit breaker

**p-chat already ships this as a first-class command.** In `plugins/p-chat/tools/pchat.mjs`,
`KNOWN` contains `'guard'` and the command exits `GUARD_QUIET` when there is nothing to
answer. That is the pattern to follow, and the reason this brief exists: **p-tasks owns the
backlog, so p-tasks should be able to answer "is there work?" itself.** Today every consumer
hand-rolls a shell wrapper around `ptasks next --json`, and each one re-derives the
selection rules slightly differently.

Verified in this checkout at p-tasks 1.1.4 — `ptasks.mjs:361` has
`KNOWN = ['init', 'add', 'set', 'next', 'summary', 'list', 'sync']`, with no `guard`.

## What to build

`ptasks guard` — exits `75` when there is no actionable work, `0` when there is.

**Reuse `pickNext` from `lib/next.mjs`. Do not reimplement the selection rules.** If the
guard and `next` ever disagree about what counts as actionable, the loop either skips work
that exists or launches an expensive run that immediately finds nothing to do. One
definition, one code path.

### Options

- `--exclude-origin <prefix>` — repeatable. Skip items whose `origin` starts with `<prefix>`.

  This is not hypothetical. The convention `origin: human:<something>` marks an item parked
  on a person: a question the loop asked and cannot answer itself. Such items are
  legitimately open and `pickNext` legitimately returns them, but a worker launched for one
  can only re-read the question and stop. Without this flag the guard reports "there is
  work" for a backlog consisting entirely of unanswered questions — which is exactly the
  state that makes an autonomous system look stalled while burning a run every hour.

- `--json` — consistent with the other commands' output shape.

### Output

Print **one short line to stdout** naming the reason, in both directions:

```
$ ptasks guard --exclude-origin human:
нет задач: 3 открытых, все ждут ответа человека      # exit 75
$ ptasks guard
готова к работе: st-206                              # exit 0
```

Keep it under ~100 characters and on one line. A sibling p-shed change (brief 02) records
the last line of a guard's stdout into `lastGuard.reason` and prints it in `pshed status`,
so this string is what an operator will read when asking "why did the worker not run?".

## Acceptance

Unit tests over `pickNext`'s input shape:

| case | expected |
|---|---|
| empty backlog | 75 |
| every item `done` | 75 |
| one actionable item | 0 |
| open items, but all with a non-`done` blocker | 75 |
| open items, but all excluded by `--exclude-origin` | 75 |
| one excluded + one actionable | 0 |
| blocker id that does not exist | 75 (matches `pickNext`, which excludes and warns) |

Plus an end-to-end test through the CLI in the style of `cli-next.test.ts`, asserting the
process **exit code**, not just the printed text — the exit code is the entire contract.

Also required:

- `KNOWN` updated so the command is dispatchable.
- The quiet exit code must be `75` and should reference the same reasoning as p-chat's
  `GUARD_QUIET` (sysexits `EX_TEMPFAIL`; deliberately a value no crashing tool emits by
  accident, so a broken guard surfaces as an error instead of reading as eternal quiet).
- `plugins/p-tasks/.claude-plugin/plugin.json` — bump `version` (minor: additive command)
  and extend `description` to name the command. Without the bump the marketplace cache
  keeps end users on the old code.

## Constraints

- `.claude/CLAUDE.md` applies. If implemented on Windows, run the e2e suites under WSL too
  and report both platforms' numbers.
- Do not change the meaning of any existing command.
- No release tag or push without explicit confirmation.
