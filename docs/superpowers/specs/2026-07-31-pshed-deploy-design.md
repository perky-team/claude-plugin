# p-shed `deploy` / `wait-idle` — design

Date: 2026-07-31
Status: **Design settled**, ready for an implementation plan.
Deliverable: two new commands (`wait-idle`, `deploy`), two new lib modules, one new
run-file (`run/DEPLOY`), a `--` terminator in the shared arg parser, an orphan reclaim in
`tick`, and a two-line change to the pause-marker origin rules. The version bump to
p-shed 0.10.0 is deferred to a release — `plugin.json` stays at 0.9.0 until the repo
owner asks for one (see the project's release-tagging rule).

Every claim in §3 about existing p-shed behavior was measured against the code in this
repo, not inferred; the measurement is named next to it. The five failures in §0 come
from the live system and are the owner's report — they are not reproducible from this
repo, which holds neither that machine nor the two scripts.

## 0. Motivation

Changing anything inside a repo that a live p-shed loop is driving — a prompt, a script,
a config — requires a window in which no job is writing the checkout. There is no p-shed
command for that today, so every operator hand-rolls it, and hand-rolling it has failed
in five distinct ways on the live system:

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

**Why not ship only `wait-idle` and document the dance.** Because the dance is what
fails. An operator writing `wait-idle && pause && cmd; resume` re-creates trap 1 (order)
and trap 4 (a dropped ssh leaves the loop paused). The value is that the sequence is
indivisible and its cleanup is not the caller's problem.

## 1. Commands

```
pshed wait-idle [--group <name>] [--timeout-sec <n>] [--poll-ms <n>] [--json]
pshed deploy --reason "<text>" [--group <name>] [--timeout-sec <n>] [--poll-ms <n>] [--json] -- <cmd> [args...]
```

`wait-idle` blocks until no job (or no member of `--group`) holds a live pidfile, then
exits 0. On timeout it exits 1 and names the holder. It changes no state — it is the
honest primitive, and it is what a human wants when the next step is manual.

`deploy` is the full dance, and the ordering is the point:

```
0. claim ownership     write run/DEPLOY {pid, scope, reason} FIRST — see §3.1
1. wait-idle           never pause first (trap 1)
2. pause               global run/PAUSED, or run/<id>.pause per group member
3. re-check idle       a job may have launched in the gap between 1 and 2
   └─ now busy: undo our pause, retry from 1 within the remaining timeout
4. run <cmd>           stdio inherited; its exit code becomes deploy's
5. release             remove only what WE placed, then run/DEPLOY
                       runs on success, failure, and (POSIX) SIGINT/SIGTERM
```

Defaults: `--timeout-sec 1800` (the longest observed worker run), `--poll-ms 1000`.
`--reason` is required for `deploy` — it lands in the pause marker, and a paused loop
with no stated reason is the thing `status` exists to prevent.

## 2. Scope

`deploy` targets the whole scheduler, or one concurrency group via `--group`. It reuses
`resolveTarget` (`lib/target.mjs`) unchanged, so an unknown group is a loud exit 2 —
never a silent widening to global, the regression that file exists to prevent.

There is deliberately **no `--id`**: pausing one job while a groupmate keeps writing the
same working directory is a window that only looks safe. There is no `--cwd` either;
the concurrency group is already p-shed's name for "jobs sharing a checkout".

`--id` must therefore be **rejected with exit 2**, not ignored. `parseArgs` swallows
unknown flags silently, so `pshed deploy --id worker -- cmd` would otherwise pause the
ENTIRE scheduler while the operator believes one job was targeted — the precise
regression `lib/target.mjs` was written to stop. Rejecting it also leaves the door open
to add `--id` later with real semantics, instead of it having quietly meant "global".

**Out of scope: file transfer.** `deploy` runs a command; it does not know about `scp`,
CRLF conversion or git. Keeping it a plain command runner is what makes it reusable
outside the one loop that motivated it. The name is `deploy` because that is the
operation an operator has in mind; it is not licence to grow transfer logic later.

## 3. Ownership, and surviving our own death

The spec this replaces relied on a signal trap. Measured: on Windows a Node process
receives **neither SIGTERM nor SIGINT** — a `process.kill(pid, 'SIGTERM')` against a
process with a listener installed killed it silently, handler never invoked, and the
same for SIGINT. A trap is therefore a POSIX-only nicety, not the mechanism. SIGKILL,
a reboot and a power cut defeat it on every platform.

So ownership is recorded on disk and reclaimed by the tick.

### 3.1 `run/DEPLOY`

```json
{ "pid": 12345, "scope": "global", "group": null,
  "reason": "prompt update", "createdAt": 1753960000000 }
```

Written **before** the pause, so the "marker exists, owner unknown" window cannot open.
The reverse window (DEPLOY exists, nothing paused yet) is harmless — there is nothing
to reclaim.

It is safe to add this file: measured, the only reader of `.pshed/run/` is
`pids.mjs:41`, whose regex is `^(.+)\.pid$`. `run/DEPLOY` therefore cannot become a
phantom job in `status` or in `stop --kill`'s `terminateJobs` — the exact trap CLAUDE.md
records against `run/<group>.pid`.

### 3.2 Marker origin

A marker placed by `deploy` says so:

- global: `run/PAUSED` gains `"origin": "deploy"`. Measured: unknown fields survive the
  read/write round-trip, and `writeGlobalPause` over an existing marker does not
  overwrite it — it returns `alreadyPaused: true` and keeps the original reason.
- per job: the existing header line, `#pshed origin=deploy`. The format is unchanged;
  `ORIGIN_HEADER` already matches `[a-z]+`.

**The pid does not go in the header.** Measured: `#pshed origin=deploy pid=123` fails
the regex, is read back as a *self*-pause with the whole header as its human-readable
reason, and `reset-breaker` on an unrelated job then **deletes the live deploy's pause**.

### 3.3 The two-line change to `breaker.mjs`

`readPauseRecord` currently collapses every recognised non-`self` origin to `operator`,
and `resetBreaker` keeps exactly `operator`. Measured: `#pshed origin=deploy` therefore
reads back as `operator` today and does survive `reset-breaker`.

That is not good enough, and the reason is correctness, not cosmetics: if a deploy pause
is indistinguishable from an operator pause, the reclaim in §3.4 cannot tell them apart
and would lift a halt a human set deliberately — trap 1's failure mode, re-introduced.

So:

1. `readPauseRecord` returns `deploy` as its own origin.
2. `resetBreaker` keeps every marker whose origin is **not** `self` (today: `!== 'operator'`
   is the delete condition; a third origin must not fall into the delete branch).

Both load-bearing invariants hold: presence still pauses (an empty marker from `touch`
is untouched), and the reason stays plain text with no machine blob in it.

### 3.4 Reclaim

A deploy marker is an orphan when `run/DEPLOY` is absent, or its `pid` is not alive.
`tick` reclaims orphans **before** its global-pause gate — measured, that gate
short-circuits on any marker regardless of origin, so a reclaim placed after it would
never run. Reclaimed markers are reported in the tick result and appended to the log.

Since the tick runs every minute, an abandoned pause costs at most one minute of
scheduling. On Windows this is the *only* recovery path; on POSIX it backs up the trap.

Known limitation, stated rather than hidden: a recycled PID reads as a live owner and
the pause survives until a human intervenes. p-shed already carries this weakness for
every job pidfile (`isPidAlive`), so this adds no new class of failure.

**A pre-existing pause is never touched.** If step 2 finds a marker already there, we
did not place it, we do not remove it, and the result says so. Silently resuming a
deliberately halted loop is worse than not deploying.

## 4. Output protocol

`deploy` breaks p-shed's stdout-JSON convention on purpose: stdout and stderr belong to
the deployed command (`stdio: 'inherit'`, measured to pass output through and expose the
child's code). p-shed's own report goes to **stderr** — progress lines normally, a single
JSON object with `--json`. Mixing a scheduler JSON blob into `git push` output would make
both unparseable.

`wait-idle` runs no command, so it keeps the house style: JSON on stdout via `emitJson`.

## 5. Exit codes

| Code | Meaning |
|---|---|
| 0 | the command ran and succeeded |
| *n* | the command ran and exited *n* |
| 128+signum | the command was killed by a signal (shell convention) |
| 127 | the command could not be spawned — POSIX only, see below |
| 130 | the operator interrupted the deploy (SIGINT); nothing is left paused |
| 1 | timed out waiting for idle — nothing was paused, nothing ran |
| 2 | validation: unknown group, `--id` (see §2), missing `--reason`, missing `--`, no command after `--` |

127 is inherently platform-dependent and the spec does not pretend otherwise: measured,
a shell-less POSIX spawn of a missing binary raises `ENOENT`, which maps to 127, while
with `shell: true` on win32 the shell reports plain exit 1. What holds on both platforms
is the part that matters — the loop is left un-paused.

**Cancellation covers the wait, not just the command.** An interrupt arriving while
`deploy` is still waiting for idle has no child process to kill, so the wait itself polls
a cancel flag and unwinds. A signal handler must never call `process.exit()`: that would
skip the release and leave the loop paused — the failure this whole design exists to
prevent.

1 and 2 are ambiguous with a command that itself exits 1 or 2. This is accepted: `--json`
carries an unambiguous `error.code`, and the alternative (inventing a private code) is
worse for a plain command runner.

## 6. Implementation notes

- **`--` terminator.** Measured: `parseArgs(['--reason','fix','--','git','commit'])` today
  yields `{_:['commit'],reason:'fix','':'git'}` — the bare `--` swallows `git` as the value
  of an empty key. `parseArgs` must stop at `--` and return the remainder verbatim. This is
  a shared function; `cli-entry.test.ts` must pin that no existing command's parse changes.
- **`shell: process.platform === 'win32'`.** Measured: `spawn('npm', ['--version'])` without
  a shell fails ENOENT on Windows (`npm` is a `.cmd` shim) and succeeds with `shell: true`;
  `git` works either way. POSIX stays shell-less so arguments are not re-interpreted.
- **New modules.** `lib/idle.mjs` (`listHolders`, `waitForIdle`) and `lib/deploy.mjs`
  (`runDeploy`). Both take injectable `isAlive` / `readPid` / `sleep` / `now` / `spawn`,
  matching `terminateJobs` — the wait is testable without real processes or real time.
- **Holders.** Global scope = every live `run/*.pid` (`listRunningJobs`, measured to drop
  dead pids). Group scope = live pidfiles of jobs whose `resolveGroup` matches, so
  `defaults` inheritance and an explicit `null` opt-out behave as the tick's gate does.
- **CLAUDE.md.** Add a note fencing this off from the standing "never a wait" rule: the
  tick still skips and never waits; `wait-idle` is a foreground operator command, and the
  distinction must survive future contributors.

## 7. Test obligations

Both directions, per the standing rule that a gate is not trusted until it has been
watched go red.

`lib/idle.mjs` (unit, injected clock and liveness):
- no pidfiles → idle immediately, no state written
- live holder → blocks, proceeds when it exits
- timeout → reports the holder, does not pause
- group scope → a live job outside the group is not a holder

`lib/deploy.mjs` (unit, recorded call order):
- order is wait → pause → re-check → run → release
- a job launches between wait and pause → our pause is undone, the wait is retried
- command exits non-zero → still released, code propagated
- pre-existing operator pause → not removed, reported as preserved
- timeout → nothing paused, nothing run

Reclaim (unit):
- `origin=deploy` + dead owner → reclaimed and logged
- `origin=deploy` + live owner → left alone
- `origin=operator` + dead owner in DEPLOY → **left alone** (this is the trap-1 guard)
- `origin=deploy` with no `run/DEPLOY` at all → reclaimed

CLI e2e:
- `--id` exits 2 **and leaves `run/PAUSED` absent** — the assertion that matters is that
  a rejected target paused nothing, mirroring `cli-pause-e2e.test.ts`
- `--` passes a command carrying its own flags through untouched
- the command's exit code is deploy's exit code
- command output is not interleaved with p-shed's `--json` report
- `run/DEPLOY` creates no phantom job in `status` and none in `stop --kill`
- SIGINT mid-command still releases — **POSIX only**, skipped on win32 with the
  measurement above as the stated reason
