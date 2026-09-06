# p-statusline

A custom status line for Claude Code — the two-line bar at the bottom of the
terminal. At a glance it shows:

```
40% 80k c99% | 5h  23%[ 4h4m] 7d  41%[ 3d17h] | ⎇ wt:feature-x* ↑1↓0
Opus high    | ...ts/perky.team/claude-plugin | Изучить statusline | RAM 41%
```

**Line 1**
- **Context window** — usage percentage, token count, and cache-hit %. The %
  and token count share a green → red ramp that warms as the window fills.
  Shows `-%` before the first API response, when nothing has been consumed yet,
  and `c-` for the cache figure right after `/compact`, until the next response.
- **Rate limits** — the 5-hour and 7-day usage windows, each with a countdown
  to reset. `n/a` until Claude Code reports the data. Both blocks are fixed
  width, so `%`, `[` and `]` hold their columns as the numbers change. The
  7-day block is one column wider: in its last day it shows minutes too, as in
  `10h41m`.
- **Git** — branch name, `*` for uncommitted changes, a `wt:` marker inside a
  linked worktree, and `↑/↓` commits ahead of / behind upstream. The marker is
  yellow `wt` with a gray `:` — it is the one thing on the bar saying you are
  not in the main working tree, so it is not dimmed. Renders `⎇ no git` (dim)
  when the project directory is not a git repository.

**Line 2**
- Model and effort level.
- The project directory.
- The session name — the one set with `--name` or `/rename`, or else the title
  Claude Code writes from your first prompt. Shows `-` until that title exists,
  and again right after `/clear`. It is cut to whatever room is left on the
  line, and dropped entirely when the terminal is too narrow for any of it.
- System RAM usage.

The leading segments of lines 1 and 2 are padded to equal width so the first
`|` separator lines up vertically.

Everything on the bar comes from the JSON Claude Code pipes to the script on
stdin. The script reads no files and runs git only for the branch segment, so a
render costs four short git calls and nothing else.

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
   /p-statusline:install
   ```

   This copies the status line script to `~/.claude/p-statusline/` and adds a
   `statusLine` entry to `~/.claude/settings.json`. If you already had a
   status line configured, its previous value is saved to
   `~/.claude/p-statusline/statusline.prev.json`.

   The entry carries `"refreshInterval": 10`. Without it Claude Code re-runs the
   script only on events — a new reply, `/compact`, a mode change — and the two
   clocks on the bar, the rate-limit countdowns and the RAM figure, would freeze
   while the session sits idle. Re-running every 10 seconds keeps them true and
   costs nothing: the status line runs locally and uses no API tokens.

3. Restart Claude Code. The status line appears at the bottom of the terminal.

## Legend

Run `/p-statusline:help` for a reference of what every element on the bar
means — the context segment, rate-limit windows, git markers, and lines 2 and 3.

## Updating

After the plugin updates, run `/p-statusline:install` again to copy the newer
script into place. Re-running it also refreshes the `statusLine` entry, which is
how an install made before `refreshInterval` existed picks the key up.

## Removing

1. Delete the `statusLine` key from `~/.claude/settings.json` (or restore the
   value saved in `~/.claude/p-statusline/statusline.prev.json`).
2. Delete the `~/.claude/p-statusline/` directory.
3. Restart Claude Code.
