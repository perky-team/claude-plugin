---
name: watch
description: Start the live p-observe event stream for the current repo. Use when the user says "watch plugins", "show plugin activity", "what are the plugins doing", or "stream p-observe".
---

# /p-observe:watch

Launch the live stream. This is a long-running foreground process — tell the user to press Ctrl-C to stop.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" watch
```

Options to offer:
- `--plugin=shed|tasks|graph|wiki` — filter to one plugin.
- `--severity=warn` — only warnings and errors.
- `--journal` — also persist events to `.pobserve/events.jsonl`.

For "what happened while I was away", prefer keeping `pobserve capture` running continuously (it
persists the full timeline); a later `watch` backfills from that journal. Without a running capturer,
a cold `watch` shows p-shed's full log plus the current end-state of the other three (§ design spec).
