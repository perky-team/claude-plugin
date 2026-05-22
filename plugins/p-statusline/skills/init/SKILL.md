---
name: init
description: Install the p-statusline status line into Claude Code. Copies statusline.cjs to a stable path and writes the statusLine block into the user's ~/.claude/settings.json. Use when the user says "init p-statusline", "install statusline", or "set up the status line".
argument-hint: (no arguments)
allowed-tools: Bash(echo:*) Bash(node:*) Bash(mkdir:*) Bash(cp:*) Read Write
---

# /p-statusline:init

You are installing the `p-statusline` status line for the current user. This
writes to the **user-level** `~/.claude/settings.json`, not a project file —
a status line is a personal, global setting.

## Step 1 — Resolve the home directory

Run `echo "$HOME"` via Bash. Trim the result; call it `<home>`. If it is
empty, stop and tell the user you could not determine their home directory.

## Step 2 — Resolve the Node.js binary

Run `node -e "console.log(process.execPath)"` via Bash.

- If it succeeds, trim the output — call it `<node>` (an absolute path to the
  `node` binary, e.g. `C:\Program Files\nodejs\node.exe`).
- If it fails (Node is not on `PATH`), set `<node>` to the literal string
  `node` and warn the user: "Node.js was not found on PATH — the status line
  will only work if `node` is on PATH when Claude Code runs." Continue anyway.

## Step 3 — Copy the script to a stable path

The plugin's install directory moves on every update, so the script must live
somewhere stable and user-owned.

1. Create the target directory: `mkdir -p "<home>/.claude/p-statusline"`.
2. Copy the script:
   `cp "${CLAUDE_PLUGIN_ROOT}/statusline/statusline.cjs" "<home>/.claude/p-statusline/statusline.cjs"`.

If the copy fails because the source is missing, stop and tell the user the
plugin install may be corrupted. If it fails for any other reason, stop and
show the exact shell error.

Call the destination `<script>` = `<home>/.claude/p-statusline/statusline.cjs`.

## Step 4 — Read the settings file

Read `<home>/.claude/settings.json`.

- **Missing** → treat the settings as an empty object `{}`; you will create
  the file in Step 6.
- **Present but not valid JSON** → stop with: "Cannot proceed:
  `<home>/.claude/settings.json` is not valid JSON. Fix it manually and
  re-run `/p-statusline:init`."
- **Present but the parsed root is not a JSON object** (e.g. an array) → stop
  with: "Cannot proceed: `<home>/.claude/settings.json` root is not an
  object. Fix it manually and re-run `/p-statusline:init`."

## Step 5 — Protect an existing status line

Build the target command string (both paths quoted — they may contain spaces):

```
"<node>" "<script>"
```

Inspect the existing `statusLine` key:

- **Absent** → nothing to protect; continue.
- **Present, an object whose `command` is a string that already contains `p-statusline/statusline.cjs` or `p-statusline\statusline.cjs`** → p-statusline is already installed. Tell the user so. Continue (Step 6 still refreshes the command, which corrects a moved home or a changed Node path).
- **Present in any other form** — a different command, an object without a string `command`, or a non-object value → save the existing value verbatim to `<home>/.claude/p-statusline/statusline.prev.json` (pretty-printed JSON, 2-space indent, trailing newline). Warn the user that their previous status line was replaced, and tell them where the backup is.

## Step 6 — Write the settings file

Set the `statusLine` key to:

```json
{ "type": "command", "command": "<target command from Step 5>" }
```

Leave every other key in the settings object untouched. Write the whole
object back to `<home>/.claude/settings.json` with 2-space indentation and a
trailing newline. If the file did not exist, create it now with just the
`statusLine` key.

## Step 7 — Final message

Tell the user, in this order:

1. The script was installed at `<home>/.claude/p-statusline/statusline.cjs`.
2. Whether `settings.json` was created fresh or updated in place.
3. If a previous status line was backed up, where the backup is.
4. They must **restart Claude Code** for the status line to appear.
5. To update later (after a plugin update) or to repair the config, just run
   `/p-statusline:init` again.

## Edge cases

- `~/.claude/settings.json` is invalid JSON → stop (Step 4).
- The settings root is not an object → stop (Step 4).
- `statusline.cjs` source is unreadable → stop, "plugin install may be
  corrupted" (Step 3).
- Node is not on `PATH` → continue with the bare string `node`, warn
  (Step 2).
- `mkdir` or a write fails (permissions) → stop, show the exact shell error.
- Re-run after a plugin update → Step 3 overwrites the copy with the new
  version, Step 5 reports "already installed", the command is refreshed.
  Safe and idempotent.
