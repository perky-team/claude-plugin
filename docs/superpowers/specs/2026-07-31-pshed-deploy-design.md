# p-shed `deploy` / `wait-idle` — design

Date: 2026-07-31
Status: **DRAFT — not approved.** Raised from operating the live HFT loop; written so the
evidence is not lost. Needs the owner's review before implementation.
Deliverable: p-shed 0.10.0 (two new commands, no schema change)

## 0. Motivation

Changing anything inside a repo that a live p-shed loop is driving — a prompt, a script,
a config — requires a window in which no job is writing the checkout. There is no p-shed
command for that today, so every operator hand-rolls it, and hand-rolling it has failed
in five distinct ways on the live system. All five are measured, not hypothetical:

| Trap | What happened |
|---|---|
| Pause before waiting for idle | Pausing first silences the whole tick, including the read-only chat jobs, for the *entire* remaining run of an in-flight 30-minute worker. Observed 2026-07-30: the phone went dark for 20 minutes. The correct order — wait for idle, *then* pause — costs ~4 s. |
| `pgrep -f <pattern>` over ssh | A remote command runs as `bash -c "<the whole text>"`, so `ssh host "pgrep -f 'claude -p …'"` matches **itself** and reports the loop busy forever. A stale background waiter carrying the pattern in its argv poisoned a 30-minute wait loop the same way. |
| `pkill -f 'until ! pgrep'` | Killed its own shell — the pattern matched the process running it. |
| Interrupting `ssh host cmd` | Cancels only the local end. Observed 2026-07-31: a rejected deploy still waited for idle, committed, pushed and resumed the loop; the retry then reported "no changes" and the operator diagnosed a phantom. |
| `if grep … \| head -3; then abort; fi` | Pipeline status comes from `head`, always 0 — the guard could never pass and blocked its own deployment. A gate broken in the direction that makes it *always* fire looks identical to a working one. |

The workaround in production is two scripts, ~71 lines, living outside any repo
(`~/.auto/loop-busy.sh`, `~/.auto/loop-deploy.sh`). They hardcode the versioned
`…/p-shed/<ver>/tools/pshed.mjs` path and therefore must be re-pointed by hand on every
p-shed upgrade — already done for 0.8.0 and 0.9.0 inside two days.

**The argument for putting this in p-shed rather than in a script: p-shed is the only
component that knows the answer without guessing.** It owns the per-job pidfiles, the
concurrency-group registry and the pause markers. An external script has to reconstruct
all three by matching process command lines — which is precisely what produced traps 2
and 3 above. Every one of these failures is a symptom of asking the OS a question the
scheduler could answer directly.

## 1. Commands

```
pshed wait-idle [--group <name>] [--timeout-sec <n>] [--json]
pshed deploy --reason "<text>" [--group <name>] [--timeout-sec <n>] -- <cmd> [args...]
```

`wait-idle` blocks until no job (or no member of `--group`) holds a pidfile, then exits 0.
On timeout it exits 1 and reports the holder. It changes no state — it is the honest
primitive, and it is what a human wants when the next step is manual.

`deploy` is the full dance, and the ordering is the point:

```
1. wait-idle            (never pause first — see trap 1)
2. pause                (global, or --group)
3. re-check idle        (a job may have launched in the gap between 1 and 2)
   └─ if now busy: resume, and retry from 1 within the remaining timeout
4. run <cmd>            (inherits stdout/stderr; its exit code becomes deploy's)
5. resume               (in a trap: runs on success, failure, SIGINT and SIGTERM alike)
```

## 2. Semantics that must not be got wrong

- **A pre-existing operator pause is preserved.** If the loop was already paused before
  `deploy` ran, step 5 must leave it paused and say so — same rule `reset-breaker` already
  follows for `operatorPause`. Silently resuming a deliberately halted loop is worse than
  not deploying.
- **Resume is unconditional.** A failing command, a non-zero exit, an interrupt, a killed
  ssh client — all still resume. The trap is the feature; a deploy that dies holding a
  global pause takes the whole loop down until a human notices.
- **`--` terminates option parsing**, so the deployed command may carry its own flags.
- **Exit codes:** `0` command succeeded · `1` timed out waiting for idle (nothing was
  paused, nothing ran) · the command's own code if it ran and failed · `2` validation
  (unknown group, missing `--`, no command).
- **`wait-idle` must not poll `pgrep`.** It reads p-shed's own `run/` pidfiles, verifying
  liveness of the recorded pid rather than pattern-matching command lines.

## 3. Test obligations

Both directions, per the standing rule that a gate is not trusted until it has been
watched go red:

- idle loop → returns immediately, does not pause anything
- busy loop → blocks, then proceeds when the holder exits
- job launches between wait and pause → detected, resumed, retried
- command exits non-zero → still resumed, exit code propagated
- SIGINT during the command → still resumed
- pre-existing operator pause → still paused afterwards, reported
- timeout → exit 1, nothing paused, holder named

## 4. Out of scope

File transfer. `deploy` runs a command; it does not know about `scp`, CRLF conversion or
git. Keeping it a plain command runner is what makes it reusable outside the one loop
that motivated it.
