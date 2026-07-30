# p-chat

A deliberately **dumb** Telegram channel for Claude Code loops: the mouth and ears,
never the brain. p-chat never schedules anything and never decides content — p-shed
jobs own both (p-shed = brains/schedule, p-observe = eyes, p-chat = mouth and ears).
Zero external deps: the Bot API is plain HTTPS + JSON on Node ≥ 18.

The core trick: `pchat guard` is a [p-shed job guard](../p-shed/README.md#job-guards).
On each tick it peeks the Telegram update queue (one cheap HTTPS call, no long poll,
no daemon):

- **Scripted commands** (`/status`, `/jobs`, …) are answered by the guard itself —
  no Claude launch, so they work even when Claude is down or usage-limited.
- **A free-text question** makes the guard exit `0` → p-shed launches the Claude
  responder (the `respond` skill). Claude runs exactly as often as there are
  questions, and never otherwise (exit `75` = quiet).
- **A broken channel** (network, bad config, empty allowlist) exits `2` → p-shed's
  breaker makes it visible.

## Skills

| Skill | Purpose |
|---|---|
| `/p-chat:init` | Guided setup: BotFather walkthrough, token file, `pchat init`, smoke send. |
| `/p-chat:respond` | The responder job's script: `pending` → answer → `send` → `ack` → session append. |

## Commands

Tool: `node tools/pchat.mjs <command>` (JSON output; exit `0` ok / `1` internal / `2` config-API error / `75` guard-quiet):

| Command | Purpose |
|---|---|
| `init --token-file <p> [--chat-id <id>] [--api-base <url>]` | Verify token (`getMe`), discover + allowlist the chat id (from the owner's seed message when `--chat-id` is omitted), baseline the cursor, write `.pchat.json`, gitignore `.pchat/`. |
| `guard` | The p-shed guard: peek queue, serve scripted commands, exit `0` question-pending / `75` quiet / `2` broken. |
| `pending` | List unacked free-text messages — the contiguous prefix up to (not including) the first scripted command, so an `ack` can never confirm an unexecuted command. |
| `ack --until <update_id>` | Confirm processing up to and including `<update_id>`. Monotonic — refuses to move backwards. |
| `send [--to <chatId>] <text \| ->` | Post a message (arg or stdin). Splits at 4096, tries Markdown, falls back to plain text if Telegram rejects the parse. Refuses targets outside `allowedChatIds`. |
| `reset` | Truncate the session transcript. |
| `status` | Offsets, last poll time, session size, allowlist, configured commands. |

## Config — `.pchat.json` (committed; contains no secrets)

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

Optional fields: `apiBase` (default `https://api.telegram.org`; also the test seam),
`commandTimeoutSec` (default 15), `apiTimeoutSec` (default 10).

Security model, in one table:

| Boundary | Rule |
|---|---|
| Token | Lives ONLY in `tokenFile` (chmod 600; checked on POSIX) — never argv, env dumps, repo files, or logs. |
| Inbound | `allowedChatIds` is fail-closed: empty allowlist = exit 2, never "respond to anyone". Non-allowlisted chats are logged locally and skipped — no reply, no error. |
| Commands | Message text either EXACTLY equals a `commands` key (after trim) or it is free text. No prefix match, no interpolation — text never reaches a shell. |
| Outbound | `send` refuses any `--to` outside `allowedChatIds` — a confused prompt cannot exfiltrate to an arbitrary chat. |

State lives in `.pchat/` (gitignored): `offset.json` (single `confirmed` cursor),
`session.md` (chat transcript; the responder appends, `reset` truncates),
`log.jsonl` (append-only local channel log: skipped updates, splits, errors).

## Mechanics: peek, confirm, at-least-once

`getUpdates` with `offset = confirmed + 1, timeout: 0` is a **peek** — Telegram
re-serves updates until a later offset confirms them (and holds them ~24 h). The
guard processes updates strictly in queue order with a single cursor and **stops at
the first free-text message**: everything from there on stays unconfirmed for the
responder. Telegram confirms *everything* below an offset, so the cursor never jumps
an unanswered question; a `/command` queued behind a question simply runs on the next
guard pass after the responder acks.

Delivery to the responder is **at-least-once**: `ack` runs only after the answer was
sent. A crash between `send` and `ack` yields a duplicate answer — duplicate beats
silence.

## Wiring the responder job (p-shed)

    - id: chat-responder
      schedule: "* * * * *"
      guard: "node <this plugin>/tools/pchat.mjs guard"
      guardTimeoutSec: 120
      maxConsecutiveFailures: 10
      prompt: "Invoke the p-chat respond skill: answer pending questions."

`guardTimeoutSec: 120` gives scripted commands room; `maxConsecutiveFailures: 10`
keeps a few minutes of network outage from tripping the breaker (each outage minute
is one guard error). While the responder is running, p-shed's live-pid gate skips
the tick entirely — the guard and the responder never race over the cursor. A
guard-only `session-clean` job (see the p-shed README) can truncate the session
nightly via `pchat reset`.

## Known limitations

- One deployment per repo root (one `.pchat.json`, one cursor). One bot per repo.
- `log.jsonl` is append-only (no rotation) — spam from non-allowlisted chats grows
  it; it is gitignored and safe to delete.
- Group chats: commands sent as `/status@yourbot` do not exact-match a `/status`
  key — the design targets a 1:1 chat with the owner.
- `pshed pause` silences the chat too (the guard never runs while p-shed is paused);
  keep an independent alarm path for that case.
