---
name: next
description: |
  Return the most relevant unblocked item to work on next. Use when the user says "next task", "what should I work on", "что делать дальше", or asks to be assigned the next thing.
argument-hint: "[--all] [--explain]"
allowed-tools: Bash(node:*) Read
---

# /p-tasks:next

## Step 1 — Choose breadth

By default the command returns one item. If the user asks for "the whole list" or "everything I could do", pass `--all`.

## Step 2 — Choose whether to explain

Pass `--explain` when the user asks **why** — "why that one", "why not t-41", "why is nothing
ready", "what is blocking X" — or when you are about to disagree with the queue's choice.
It adds an `explain` object and changes nothing else; the selection is identical with and
without it. Do not pass it by default: it is noise when the user just wants the next task.

## Step 3 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" next [--all] [--explain] --json
```

## Step 4 — Render

If `{next: null}` or empty `items`: tell the user nothing is unblocked. With `--explain`,
`explain.excluded` says what is holding everything back — use it instead of stopping at "nothing to do".

Otherwise: identify the item by id + title, mention its status, and (for sub-tasks) the parent.

## Step 5 — Render the explanation, if asked for

`explain.ranking` lists candidates with the key that ranked each: `statusRank`,
`parentInProgressRank`, `prefixRank`, `num`. **Lower wins on every key**, compared left to
right — `parentInProgressRank: 0` means "this sub-task's parent IS in progress", which is
better than `1`. Name the FIRST key on which the winner beat the item the user asked about;
that one key is the whole answer.

`explain.ranking` is capped at 10 entries. `explain.candidateCount` is the untruncated total —
if it exceeds the number of entries shown, say so rather than implying the list is complete.

`explain.excluded` is never capped. Each entry's `unsatisfiedBlockers` holds every not-yet-done
blocker from that item's own `blockedBy`, with its current status; `{"status": null, "missing": true}`
means the blocker id no longer exists, which is a data problem worth telling the user about.

**Never present `--explain` as a way to change the pick.** It reports the decision; it cannot
alter it. If the user disagrees with the ordering, the lever is the item's `status` or its
`blockedBy` — set via `/p-tasks:set` — not this flag.
