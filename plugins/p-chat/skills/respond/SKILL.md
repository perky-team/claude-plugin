---
name: respond
description: Answer pending free-text Telegram questions via the pchat CLI — read pending questions, answer each grounded in the repo, send, ack, and append to the session transcript. Use as the prompt of a p-shed chat-responder job, or when the user says "answer the chat" / "check telegram questions".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read Grep Glob
---

# /p-chat:respond

Answer pending questions from the Telegram channel. Delivery is **at-least-once**:
`ack` runs only after the answer was sent, so a crash mid-run means the next run
answers again — a duplicate beats silence. Never `ack` what you have not answered.

## Step 1 — Read the queue
    node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" pending
If `pending` is empty, stop — nothing to do.

## Step 2 — Load context
Read the session transcript at the `sessionFile` path from `.pchat.json`
(default `.pchat/session.md`) for conversation continuity.

## Step 3 — Answer each question IN ORDER
For each pending item (they arrive oldest first):
1. Compose the answer grounded in this repo's actual state (read files/status tools
   as needed — never guess). Keep it short: it is read on a phone screen.
2. Send it:
       node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" send "<answer>"
   (or pipe long text: `... send -` with the answer on stdin).
3. Confirm it — ack up to and including THIS question's updateId:
       node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" ack --until <updateId>
4. Append the Q/A pair to the session transcript file:

       ## <ISO date> — q<updateId>
       **Q:** <question>
       **A:** <answer>

## Notes
- Posting digests/reports needs none of this: any job can call `send` directly.
- If `send` fails, do NOT ack — the question stays queued and the next run retries.
