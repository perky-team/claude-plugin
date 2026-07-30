# p-shed job guards + p-chat Telegram channel — design

Date: 2026-07-29
Status: approved by Andrey (conversation); spec review done 2026-07-29 — resolutions in §6
Deliverables: p-shed 0.6.0 (guard feature), p-chat 0.1.0 (new plugin)

## 0. Motivation and rejected alternatives

Goal: read the status of an autonomous p-shed loop from a phone, away from the
machine, and ask it questions — without running a daemon, without adding cron
entries, and without burning Claude launches on empty polling.

The problem decomposes into (a) a cheap always-available transport for messages
in and out, and (b) launching a Claude responder only when there is actually
something to answer. Both are solved by one universal p-shed feature — a **guard**
— plus one deliberately dumb channel plugin — **p-chat**.

Rejected alternatives, and why (recorded so the next reader does not re-derive them):

| Alternative | Why rejected |
|---|---|
| Long-poll daemon | A long-lived process to install, supervise, and restart; owner explicitly does not want daemons |
| Separate cron entry for a poll script | Second scheduler entry to keep in sync; owner explicitly does not want it |
| Claude job polling every minute | ~1440 `claude -p` launches/day spent asking "any messages?" |
| Claude responder job every 30 min | Cheap, but answers arrive up to 30 min late and `/status` dies whenever Claude is down or usage-limited |
| Piggyback chat handling on the worker job | Chat answers would run with the worker's full write permissions; roles blur |

The accepted shape: the p-shed tick already fires every minute from the existing
cron entry. A guard lets any job put an arbitrary cheap command in front of its
Claude launch; the command decides on each due tick whether the launch happens.
For chat, the guard answers scripted commands itself (no Claude, works even when
Claude is broken) and requests a launch only when a free-text question is pending
— so Claude runs exactly as often as there are questions, and never otherwise.

## 1. Part A — p-shed: job guards

### 1.1 Schema

Two new optional per-job fields in `jobs.yml` (no `defaults` support — a guard is
inherently job-specific):

```yaml
jobs:
  - id: chat-responder
    schedule: "* * * * *"
    guard: "node ~/.claude/plugins/.../pchat.mjs guard"   # NEW: shell command
    guardTimeoutSec: 30                                   # NEW: default 30
    prompt: "Invoke the p-chat respond skill: answer pending questions."
```

`set-job` gains `--guard <cmd>` and `--guard-timeout-sec <n>`. Validation
(ValidationError, exit 2): `guard` must be a non-empty string when present;
`guardTimeoutSec` a positive number. Passing `--guard ""` clears the field.

### 1.2 Contract

The guard command is executed with `shell: true`, cwd = job `cwd` (else repo
root), inherited env plus `PSHED_JOB_ID` and `PSHED_ROOT`. p-shed reads only the
exit code:

| Exit | Meaning | Effect |
|---|---|---|
| `0` | work exists | launch `claude -p` with the job's prompt, as today |
| `75` | deliberately quiet — no work this slot | skip silently; **not** a failure |
| anything else, or timeout | guard is broken | skip + count toward the job's `consecutiveGuardFailures` → breaker (§1.3) |

Why 75: POSIX exit codes are an unsigned byte, so a distinctive "quiet" value
must live in 0–255. It must also be a code no crashing tool emits by accident —
crashes exit 1/2, "command not found" is 127, non-executable 126, SIGKILL 137.
A guard author writes `exit 75` deliberately or the silence does not happen;
an accidentally broken guard therefore always surfaces as an error instead of
reading as eternal quiet (the classic fail-open reader defect). 75 is
`EX_TEMPFAIL` in `sysexits.h` — "temporary failure, try again later" — which is
exactly the semantics of "no work on this tick".

### 1.3 Tick integration

In `tick.mjs`, after the `isDue` check and before `runJob` (so the existing
gates — global pause, self-pause, breaker, live-pid — all run first and an
in-flight run suppresses the guard entirely):

```
if (job.guard) {
  g = runGuard(job, defaults)            // new lib/guard.mjs, sync, timeout
  state.lastGuard = { at: now, outcome, exit }   // always recorded
  if (g.quiet)  -> writeJobState(lastRun = now, consecutiveGuardFailures = 0)
                   results 'guard-quiet'; continue
  if (g.error)  -> writeJobState(lastRun = now, consecutiveGuardFailures + 1,
                                 breaker trips when it reaches maxFailures,
                                 breakerReason 'guard exit N' | 'guard timeout')
                   appendLog({ outcome: 'guard-error', exit, raw: stderr tail })
                   results 'guard-error'; continue
  // pass: consecutiveGuardFailures = 0; fall through to runJob;
  // the launch log record gains guarded: true
}
```

Decisions folded in:

- **A quiet guard consumes the schedule slot** (`lastRun = now`), consistent with
  the usage-limit skip path. A daily guarded job whose guard says quiet at 09:00
  next tries tomorrow at 09:00 — it does not hammer the guard every minute all
  day. For `* * * * *` jobs this is irrelevant (every minute is a slot).
- **Two failure counters, one breaker.** Guard errors increment their own
  `consecutiveGuardFailures`; run failures keep the existing
  `consecutiveFailures`. The breaker trips when either reaches
  `maxConsecutiveFailures`, so the watchdog alerting on `breakerTripped` needs
  no change. They must be separate because their reset events differ: a quiet
  or passing guard proves the guard healthy (resets the guard counter) but says
  nothing about the run; a successful run proves the run healthy (resets the
  run counter) but not vice versa. A single shared counter fails both ways:
  three transient guard blips weeks apart would eventually trip the breaker on
  a healthy job, while a genuinely crashing responder whose failures are
  interleaved with quiet slots would reset the counter each time and never trip.
- **Log noise policy**: `guard-error` and launches go to the history log;
  `guard-quiet` goes only to the per-job state (`lastGuard`) and the live tick
  result. A minutely chat job must not write 1440 "quiet" history lines/day.
  `status` surfaces `lastGuard` so freshness ("checked 40 s ago") stays visible.
- Guard stdout/stderr are captured and truncated with the existing
  `truncateOutput` helper; stderr tail is attached to `guard-error` log records.
- Timeout kill: SIGTERM, then SIGKILL after a short grace (mirror `launch.mjs`).
- Guards are never classified as usage-limit — that concept belongs to Claude runs.
- `pshed run <id>` respects the guard; `--no-guard` bypasses it for debugging.
- First-tick baselining is unchanged (no guard run on the baseline tick).

### 1.4 Guard-only jobs (documented pattern)

A job whose guard does all the work and then exits 75 is a **free scheduled
command** — cron-driven work with no Claude launch, but with full p-shed
supervision and `status` visibility: in `cmd && exit 75`, a failing `cmd`
short-circuits the `&&`, the guard exits with `cmd`'s error code, and the
breaker path fires. `prompt` remains required and serves as documentation of
what the guard does; it simply never launches.

```yaml
  - id: session-clean
    schedule: "0 4 * * *"
    guard: "node .../pchat.mjs reset && exit 75"
    prompt: "(guard-only) Reset the p-chat session nightly."
```

This officially covers the "exec job" need without a second job type, and is the
future migration path for the Pi watchdog's separate cron entry.

### 1.5 Out of scope (deliberate)

- Injecting guard stdout into the Claude prompt (revisit if a real need appears).
- Guard on `defaults`; output-pattern matching; configurable quiet code.
- Sub-minute scheduling.

### 1.6 Tests (vitest, alongside the existing p-shed suites)

- Contract mapping: exit 0 → launched (record has `guarded: true`); 75 → skipped,
  run-failure counter untouched, `lastRun` consumed; 1/2/127 → guard-error,
  guard counter incremented; timeout → guard-error.
- Breaker: maxConsecutiveFailures guard errors trip it; a subsequent guard pass
  after `reset-breaker` clears normally.
- Counter separation: a quiet guard resets only the guard counter (run failures
  survive quiet slots and still trip); guard blips separated by quiets never
  accumulate.
- Negative self-test: a guard exiting 1 must NOT be treated as quiet (this test
  encodes the fail-open lesson; it must fail if someone "simplifies" the contract
  to 0/nonzero).
- Ordering: no guard invocation when job is paused, breaker-tripped, pid-alive,
  or not due. `run --no-guard` bypasses; `run` without flag respects.
- Schema: set-job flag round-trip, validation errors, `--guard ""` clears.

## 2. Part B — p-chat: dumb Telegram channel plugin

New plugin `plugins/p-chat`, version 0.1.0. Node ≥ 18, zero external deps (the
Bot API is plain HTTPS + JSON, same discipline as the other plugins). p-chat
never schedules anything and never decides content — p-shed jobs own both, per
the ecosystem split: p-shed = brains/schedule, p-observe = eyes, p-chat = mouth
and ears.

### 2.1 CLI (`tools/pchat.mjs`)

| Command | What it does | Exit codes |
|---|---|---|
| `init --token-file <p> --chat-id <id>` | Flag-driven setup (no prompts — it is run by Claude): write `.pchat.json`, verify token file exists with 600 perms, `getMe` smoke test | 0 / 2 |
| `guard` | The p-shed guard: peek queue, serve scripted commands, decide launch | 0 work / 75 quiet / 2 broken |
| `pending --json` | List unacked free-text messages (for the responder) | 0 (possibly empty list) |
| `ack --until <update_id>` | Confirm processing up to and including `<update_id>` | 0 / 2 |
| `send [--to <chatId>] <text \| ->` | Post a message (arg or stdin), split at 4096, Markdown | 0 / 2 |
| `reset` | Truncate the session transcript | 0 |
| `status --json` | Offsets, last poll, session size — for humans and p-observe later | 0 |

### 2.2 Config and state

`.pchat.json` (committed; contains no secrets):

```json
{
  "tokenFile": "~/.config/p-chat/token",
  "allowedChatIds": [123456789],
  "defaultChatId": 123456789,
  "commands": {
    "/status": "node <p-observe>/tools/pobserve.mjs status",
    "/jobs":   "node <p-shed>/tools/pshed.mjs status --human"
  },
  "sessionFile": ".pchat/session.md"
}
```

- Token lives ONLY in `tokenFile` (chmod 600), never in argv, env dumps, or the
  repo. `init` verifies permissions and warns.
- `allowedChatIds` non-empty is mandatory for `guard`/`pending`/`send`: an empty
  allowlist is exit 2 (breaker → visible), never "respond to anyone".
- `commands` maps scripted commands to shell commands run by the guard. Message
  text is NEVER interpolated into a shell line — a message either equals a
  configured command key (exact match after trim) or it is free text. This is
  the injection boundary.
- `send` refuses any `--to` target not in `allowedChatIds` — a compromised or
  confused prompt cannot exfiltrate to an arbitrary chat.
- State in `.pchat/` (gitignored): `offset.json` (single cursor: `confirmed`),
  `session.md`, `log.jsonl` (local channel log: rejected chats, splits, errors).

### 2.3 Telegram mechanics

`getUpdates` with `offset = confirmed + 1, timeout: 0` is a **peek** — Telegram
re-serves updates until a later offset confirms them, and holds them ~24 h. The
guard exploits this:

1. Fetch pending updates (one HTTPS call, no long poll).
2. Process them **strictly in queue order**, advancing the single `confirmed`
   cursor through the processed prefix, and **stop at the first free-text
   message from an allowed chat**:
   - non-allowlisted chat → log locally, never reply, cursor advances past it;
   - exact match of a `commands` key → run the mapped command
     (timeout-bounded), `send` its output back, cursor advances past it — this
     is why `/status` works even when Claude is usage-limited or broken;
   - free text from an allowed chat → STOP: everything from here on stays
     unconfirmed for the responder, and the guard exits 0.
   In-order processing with one cursor is what makes confirmation safe: Telegram
   confirms *everything* below the offset, so the cursor must never jump over an
   unanswered question. A `/command` queued behind a question is simply answered
   on the next guard pass, after the responder acks.
3. No free text found → exit 75. Network/API/config failure → exit 2.

Delivery to the responder is **at-least-once**: `ack` runs only after the answer
was sent, so a responder that crashes mid-run leaves the question unconfirmed
and the next guard pass relaunches it. A duplicate answer after a crash between
`send` and `ack` is accepted — duplicate beats silence.

### 2.4 Sessions

Chat continuity lives in a plain transcript file (`sessionFile`), not in Claude
session plumbing: the respond skill reads it for context and appends each Q/A
pair; `reset` truncates it. When (and whether) it is cleaned is the owner's
p-shed task — e.g. the guard-only `session-clean` job in §1.4.

### 2.5 Skill

`skills/respond/SKILL.md` — the responder job's script: `pending --json` → read
`sessionFile` → answer each question (grounded in the repo; keep it short, it is
a phone screen) → `send` → `ack --until` → append to `sessionFile`. Notes that
posting digests needs no skill: any job can call `send` directly from its prompt.

### 2.6 Tests (vitest)

- Unit: offset peek/confirm arithmetic; ack monotonicity (cannot ack backwards);
  in-order stop-at-first-free-text (a `/command` behind a question is neither
  executed nor confirmed until the question is acked; the cursor never jumps an
  unanswered question); 4096 splitting on UTF-8 boundaries; allowlist filtering;
  exact-match command routing (no prefix match, no interpolation); token file
  permission check.
- E2E against a local mock Bot API server (http server in-test): guard exit
  paths 0/75/2; scripted command round-trip; at-least-once (kill between send
  and ack → message re-served).
- Negative self-tests: guard must exit 2 (not 75) on unreachable API and on
  empty allowlist; a free-text message must never reach the `commands` shell.

### 2.7 Live smoke checklist (real Telegram, after the mock suites are green)

The mock suites cover the logic; one manual round-trip against the real Bot API
validates the credentials path and the phone UX. The bot itself can only be
created by the owner — walk them through it at this point:

1. **Owner**: in Telegram, talk to `@BotFather` → `/newbot` → receive the token.
   Create TWO bots if this deployment will go to production later: a dev bot for
   this checklist and a prod bot whose token only ever lives on the target
   machine.
2. **Owner**: put the token in a file themselves (e.g.
   `~/.config/p-chat/token`, chmod 600). The token must NEVER be pasted into a
   Claude session, a repo file, or a shell argument — it would persist in
   transcripts/history (this ecosystem has prior art on leaked credentials in
   transcripts).
3. **Owner**: send the bot any message — bots cannot message first, and this
   seeds `getUpdates` with the owner's `chat_id`.
4. **Session**: `pchat init --token-file <path>` → `getMe` succeeds, the pending
   update reveals the chat id, `init` prints it and writes `.pchat.json` with it
   allowlisted.
5. **Session**: `pchat send "smoke"` → arrives on the phone. Owner replies with
   free text → `pchat guard` exits 0 → `pending` shows it → `ack` → `guard` now
   exits 75. Owner sends a configured `/command` → scripted answer arrives
   without any Claude involvement.

This checklist runs fine from any machine with Node and internet — the target
deployment machine is not required for it.

## 3. Part C — reference deployment (the Pi loop; ops repo owns the runbook)

Not part of this repo's implementation — recorded so the design is checked
against its real consumer:

- `chat-responder`: schedule `* * * * *`, guard `pchat guard`, model `sonnet`,
  narrow `allowedTools` (read-only repo access + `pchat` + explicitly whitelisted
  safe actions: `pshed pause`, `pshed resume`, `pshed reset-breaker`), modest
  `timeoutSec`. Answer latency: ≤1 min to pick up + responder runtime (~1–2 min).
- Digest/report posts: owner-defined jobs calling `send` (replaces the 6-hourly
  GitHub-only reporter visibility).
- `session-clean`: guard-only job (§1.4).
- Known consequence, accepted: `pshed pause` silences the chat too (guard never
  runs while globally paused). The existing GitHub watchdog channels stay as the
  independent alarm path; WATCHDOG-OFF procedure unchanged.
- p-observe follow-up (separate, optional): teach the pshed adapter the
  `guard-error` log outcome and surface `lastGuard` freshness; verify unknown
  outcomes degrade gracefully today.

## 4. Versioning and release

- p-shed 0.5.0 → 0.6.0 (minor: additive schema + tick behavior; jobs without
  `guard` are bit-for-bit unchanged).
- p-chat 0.1.0: new plugin — `plugin.json`, README, marketplace.json entry.
- README updates: p-shed (guard field, contract table, guard-only pattern,
  set-job flags); marketplace root README plugin list.

## 5. Acceptance

1. All new vitest suites green; existing p-shed suites untouched and green.
2. A guarded demo job in a sandbox repo: quiet guard → no Claude launch, no
   history noise; exit-0 guard → launch with `guarded: true`; 3 consecutive
   guard errors → breaker trips → visible in `status`.
3. p-chat e2e green against the mock API, including the at-least-once replay.
4. Negative self-tests present and demonstrably capable of failing (mutate the
   contract → suite goes red).
5. READMEs and marketplace entry updated; release notes follow the existing
   `chore(release)` convention.
6. Live smoke checklist (§2.7) executed once with the owner and a dev bot:
   send, free-text round-trip, scripted `/command` — all observed on a real
   phone.

## 6. Spec review resolutions (2026-07-29)

Refinements accepted during spec review; none overturn the design. Where a
resolution contradicts an earlier section, the resolution wins.

Part A:

- **A2 — timeout kill.** §1.3 said "SIGTERM, then SIGKILL (mirror `launch.mjs`)",
  but `launch.mjs` actually kills immediately via `killTree` (SIGKILL of the
  process group / `taskkill /T /F`); the two-stage kill lives only in
  `pids.mjs:terminateJobs`. `runGuard` is async and mirrors `runJob` exactly:
  timer → `killTree`. ("sync" in the §1.3 pseudocode is likewise superseded —
  `spawnSync` cannot escalate a kill and can hang on a SIGTERM-ignoring child.)
- **A3 — guard cwd.** Resolves identically to the run itself:
  `job.cwd ?? defaults.cwd ?? root` (§1.2 omitted `defaults.cwd`).
- **A4 — reset-breaker.** `resetBreaker` clears `consecutiveGuardFailures` too
  (already implied by the §1.6 test list).
- **A5 — `run <id>` stays stateless.** The guard executes; on quiet/error the CLI
  emits `{ id, outcome: 'guard-quiet' | 'guard-error', guard: {...} }` and exits 0
  without launching. No state, counters, or history log are touched — manual runs
  never affect the breaker, exactly as today.
- **A6 — `--guard ""`** clears `guardTimeoutSec` along with `guard`.
- **A7 — Windows caveat (docs only).** `shell: true` means cmd.exe on Windows:
  `~` does not expand there — guard commands need real paths. README note next to
  the existing cmd.exe prompt caveat.

Part B:

- **B1 — `pending` stop rule** (the gap that mattered): `pending` returns only
  the **contiguous prefix** of free-text messages from allowed chats, stopping
  before the first scripted-command message. Otherwise a queue of
  `[question₁, /status, question₂]` answered in one batch would `ack --until`
  past `/status`, confirming it unexecuted — violating the §2.3 invariant. The
  stopped-at command runs on the next guard pass after the ack.
- **B2 — `init --chat-id` is optional.** Without it, init peeks `getUpdates` and
  discovers the chat id (per §2.7 step 4); no pending update → exit 2 with "send
  the bot a message first". Init always baselines the cursor to the newest seen
  update so stale history is never replayed.
- **B3 — Markdown fallback.** On a 400 "can't parse entities" from sendMessage,
  retry the chunk without `parse_mode`. Delivery beats formatting.
- **B4 — non-text updates** (stickers, photos, edits, service updates) are
  treated like non-allowlisted chats: logged locally, cursor advances past.
  Free text = a `message` with `text` only.
- **B5 — `apiBase` config field** (default `https://api.telegram.org`): the test
  seam for the mock Bot API server; also covers a future local Bot API server.
- **B6 — command time/output bounds.** Scripted commands run with a per-command
  timeout (`commandTimeoutSec`, default 15) and a capped output tail sent back;
  the reference deployment sets `guardTimeoutSec: 120` on the chat job.
- **B7 — network outages vs breaker (Part C note).** Exit-2-on-network stays
  (fail-closed is correct), but 3 minutes of Pi wifi outage = 3 guard errors =
  breaker tripped = chat dead until a manual `reset-breaker` at the machine. The
  reference deployment sets `maxConsecutiveFailures: 10–15` on `chat-responder`
  so short outages survive; the GitHub watchdog remains the alarm for real trips.
- **B8 — token permission check is POSIX-only** (file mode is meaningless on
  Windows); skipped with a note on win32.
