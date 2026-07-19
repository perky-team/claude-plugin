---
name: tui
description: Launch the p-observe k9s-style TUI for the current repo — tabbed overview + per-plugin master-detail. Use when the user says "open the TUI", "p-observe dashboard", "show the observer UI", or "tui".
---

# /p-observe:tui

Launch the interactive TUI. This is a long-running foreground process that takes
over the terminal (alternate screen) — tell the user to press `q` or `Esc` to quit.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" tui
```

Keys: `Tab`/`1`-`9` switch tabs · `j`/`k` (or ↑/↓) move selection · `/` filter ·
`f` toggle follow · `q`/`Esc` quit.

Options:
- `--journal` — also persist events to per-day journal files in `.pobserve/`.

For the plain line stream instead (pipeable, no alt-screen), use `/p-observe:watch`.
For "what happened while I was away", keep `pobserve capture` running so a later `tui`
backfills the full timeline from the journal.
