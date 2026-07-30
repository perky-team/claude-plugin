---
name: init
description: Set up p-chat in the current repo — walk the owner through creating a Telegram bot and a token file, then run `pchat init` to verify the token, discover the chat id, and write `.pchat.json`. Use when the user says "init p-chat", "set up telegram chat", or "connect telegram".
argument-hint: (no arguments — the token file path is asked interactively)
allowed-tools: Bash(node:*) Read
---

# /p-chat:init

Set up the p-chat Telegram channel. One-shot; refuses if `.pchat.json` already exists.

## Step 0 — Refuse if already initialized
If `.pchat.json` exists in the repo root, stop: "p-chat already initialized here. Edit `.pchat.json` directly, or delete it to re-init."

## Step 1 — Owner creates the bot (you cannot do this for them)
Ask the owner to, on their phone or desktop Telegram:
1. Talk to `@BotFather` → `/newbot` → follow the prompts → receive the bot token.
   (If this deployment later goes to production, suggest creating TWO bots: a dev bot for now and a prod bot whose token only ever lives on the target machine.)
2. Put the token in a file themselves, e.g. `~/.config/p-chat/token`, and `chmod 600` it.
   The token must NEVER be pasted into this chat, a repo file, or a shell argument — it would persist in transcripts and history. Only ask for the *path* to the file.
3. Send the new bot any message (bots cannot message first — this seeds the chat id).

## Step 2 — Run init
Ask for the token file path, then:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" init --token-file <path>
- Exit 0: report the bot username and the discovered, allowlisted chat id.
- Exit 2 with "send the bot a message first": the owner skipped step 1.3 — ask them to send any message and re-run.
- Any `warning` about file permissions: relay it verbatim.

## Step 3 — Smoke test
    node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" send "p-chat is up"
Confirm with the owner it arrived on their phone.

## Step 4 — Explain what's next
- Scripted commands: add entries to `commands` in `.pchat.json` (e.g. `"/status": "node <path>/pobserve.mjs status"`). The guard answers them without Claude.
- Free-text answering needs a p-shed job whose guard is `node <this plugin>/tools/pchat.mjs guard` and whose prompt invokes the `/p-chat:respond` skill. Recommend `guardTimeoutSec: 120` and `maxConsecutiveFailures: 10` for that job (short network outages must not trip the breaker).
