---
name: help
description: Explain what each status line element means.
argument-hint: (no arguments)
disable-model-invocation: true
---

# /p-statusline:help

The user wants a legend for the `p-statusline` status line. Print the
reference below to them as Markdown, verbatim — do not run the script, read
any config, or inspect the current session. The example values are
illustrative; colours are described in the text since terminal output here is
not ANSI-rendered.

````
p-statusline — what each element means

Line 1 — context, limits, git (joined by " | ")

  8% 80k c99%        Context window:
                       8%    fraction of the window used
                       80k   tokens currently in context
                       c99%  cache-hit % of the last response (dim — info only)
                     The % and token count share a green→red ramp that warms
                     as the window fills. Shows "-%" before the first API
                     response, when nothing has been consumed yet, and "c-"
                     for the cache figure right after /compact, until the next
                     response.

  5h  45%[3h12m]     Rate limit, 5-hour window:
                       45%     usage of the window (green→red, redder = closer to cap)
                       [3h12m] countdown to reset (cool when far, warm when near)
  7d  12%[ 2d4h]     Rate limit, 7-day window — same layout, one column wider.
                     Each shows "n/a" until Claude Code reports the data.
                     Both blocks are fixed width, so '%', '[' and ']' stay in
                     the same columns as the numbers change. The 7-day window
                     gets the extra column because in its last day it shows
                     minutes too — "10h41m".

  ⎇ main*↑2↓1        Git:
                       main  current branch (or short commit hash if detached)
                       wt:   inside a linked worktree, before the branch —
                             yellow "wt" and a gray ":", so it is hard to miss
                       *     uncommitted changes in the working tree
                       ↑2    commits ahead of upstream (green when non-zero)
                       ↓1    commits behind upstream (green when non-zero)
                     Renders "⎇ no git" (dim) when the directory is not a repo.

Line 2 — model, directory, RAM (joined by " | ")

  claude-opus-4-8 high   Model name + effort level (any "(… context)" suffix
                         on the model name is stripped).

  .../perky.team/...     Project directory — the session launch directory.
                         Truncated from the start with a "..." prefix when long,
                         so the folder name stays visible.

  RAM 59%                System physical-memory usage (green→red as it fills).

Line 3 — session name

  auth-refactor          The name set with --name or /rename. With no name set,
                         the title Claude Code writes from your first prompt.
                         Shows "-" until that title exists, and again right
                         after /clear. Long names are cut to the terminal width.

The leading segment of each line is padded so the first " | " separator lines
up vertically across both lines.
````
