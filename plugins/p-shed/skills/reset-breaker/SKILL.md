---
name: reset-breaker
description: Un-stick a job that p-shed stopped scheduling — clears the process-level circuit breaker and the task-level self-pause marker. Use when the user says "reset the breaker", "un-stick a job", "my job stopped running", "resume a paused job", or after a job auto-disabled from repeated failures.
argument-hint: <id>
allowed-tools: Bash(node:*) Read
---

# /p-shed:reset-breaker

A job stops being scheduled for one of two reasons:

- **Circuit breaker tripped** — the launched run crashed or timed out
  `maxConsecutiveFailures` times in a row (default 3). Ticks log `skipped-breaker`.
- **Self-pause** — the job's own run left a `run/<id>.pause` marker because its
  internal work went red (`claude -p` exits 0 even then). Ticks log `skipped-paused`.

> Not this: a **usage-limit / API-overload** skip. If ticks log `skipped-usage-limit`
> (or `status` shows a `lastSkip` of `usage-limit`), the job is only waiting out a quota
> window and the breaker was never touched — it will retry on its own when the window
> resets. `reset-breaker` is unnecessary there.

## Reset
Confirm the job id, then run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" reset-breaker <id> --json

This clears `breakerTripped`/`consecutiveFailures` in the job's state **and** removes
any `run/<id>.pause` marker. It is idempotent — resetting a healthy job is a no-op.

## Report
Echo the printed JSON (`{ id, cleared: true }`) and note the job resumes on its normal
schedule from the next tick. If the underlying cause is unfixed, it will simply trip
again — check `logs/` first.
