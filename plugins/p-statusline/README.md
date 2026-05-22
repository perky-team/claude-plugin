# p-statusline

A custom status line for Claude Code — the two-line bar at the bottom of the
terminal. At a glance it shows:

**Line 1**
- **Context window** — usage percentage, token count, and cache-hit %. The %
  and token count share a green → red ramp that warms as the window fills.
- **Rate limits** — the 5-hour and 7-day usage windows, each with a countdown
  to reset. `n/a` until Claude Code reports the data.
- **Git** — branch name, `*` for uncommitted changes, a `wt:` marker inside a
  linked worktree, and `↑/↓` commits ahead of / behind upstream.
- **Task progress** — `▸ done/total` from the most recent TodoWrite, plus the
  in-progress task name.

**Line 2**
- Model and effort level.
- System RAM usage.
- The project directory.

## Requirements

Node.js — no extra install. Claude Code already runs on Node, and the script
uses only Node built-in modules.

## Install

1. Add this marketplace and install the plugin:

   ```text
   /plugin marketplace add perky-team/claude-plugin
   /plugin install p-statusline@perky.team
   ```

2. Activate the status line:

   ```text
   /p-statusline:init
   ```

   This copies the status line script to `~/.claude/p-statusline/` and adds a
   `statusLine` entry to `~/.claude/settings.json`. If you already had a
   status line configured, its previous value is saved to
   `~/.claude/p-statusline/statusline.prev.json`.

3. Restart Claude Code. The status line appears at the bottom of the terminal.

## Updating

After the plugin updates, run `/p-statusline:init` again to copy the newer
script into place.

## Removing

1. Delete the `statusLine` key from `~/.claude/settings.json` (or restore the
   value saved in `~/.claude/p-statusline/statusline.prev.json`).
2. Delete the `~/.claude/p-statusline/` directory.
3. Restart Claude Code.
