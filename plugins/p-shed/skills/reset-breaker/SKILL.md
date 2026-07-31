---
name: reset-breaker
description: Un-stick a job that p-shed stopped scheduling — clears the process-level circuit breaker and the task-level self-pause marker (an operator pause is lifted with `pshed resume --id` instead). Use when the user says "reset the breaker", "un-stick a job", "my job stopped running", "resume a paused job", or after a job auto-disabled from repeated failures.
argument-hint: <id>
allowed-tools: Bash(node:*) Read
---

# /p-shed:reset-breaker

A job stops being scheduled for one of two reasons:

- **Circuit breaker tripped** — the launched run crashed or timed out
  `maxConsecutiveFailures` times in a row (default 3). Ticks log `skipped-breaker`.
- **Self-pause** — the job's own run left a `run/<id>.pause` marker because its
  internal work went red (`claude -p` exits 0 even then). Ticks log `skipped-paused`.

> Also not this: an **operator pause** — someone ran `pshed pause --id <job>` (or
> `--group`). Ticks log `skipped-paused` for that too, but it is deliberate, so
> `reset-breaker` leaves it alone and reports `operatorPause: true`. Lift it with
> `pshed resume --id <job>` — the same person's lever, not a side effect of a reset.

> Not this: a **usage-limit / API-overload** skip. If ticks log `skipped-usage-limit`
> (or `status` shows a `lastSkip` of `usage-limit` or `api-overload`), the job is only
> waiting out a quota window or an API blip — the breaker was never touched and it will
> retry on its own. `reset-breaker` is unnecessary there.

## Reset
Confirm the job id, then run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" reset-breaker <id> --json

This clears `breakerTripped`/`consecutiveFailures` in the job's state **and** removes a
`run/<id>.pause` marker the job wrote itself. It is idempotent — resetting a healthy job
is a no-op.

## Report
Echo the printed JSON (`{ id, cleared: true, pauseCleared }`) and note the job resumes on
its normal schedule from the next tick. If the underlying cause is unfixed, it will simply
trip again — check `logs/` first.

If the output carries `operatorPause: true`, say so plainly: the breaker was cleared but
the job stays paused because a person paused it (the reason is in `pauseReason`). Do not
delete the marker — offer `pshed resume --id <id>` and let the user decide.
