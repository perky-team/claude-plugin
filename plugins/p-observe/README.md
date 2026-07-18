# p-observe

A Claude Code plugin that gives a **realtime, human-readable view** of what the other perky.team
plugins are doing at runtime — a `tail -f`-style stream plus a live snapshot — without modifying them.

Zero-touch: it only reads `.pshed/`, `docs/tasks/`, `.pgraph/`, and `docs/wiki/`, and derives a
normalized event stream. Its own writes go only under `.posebserve/` (gitignored).

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-observe@perky.team
```

## Commands

| Command | What it does |
|---|---|
| `posebserve watch` | Live merged event stream (`--plugin=`, `--severity=`, `--journal`). |
| `posebserve status` | One-shot snapshot: counters, running jobs, failures. |
| `posebserve capture` | Headless; keep running to persist the full offline timeline to `.posebserve/events.jsonl`. |

Run via `node "${CLAUDE_PLUGIN_ROOT}/tools/posebserve.mjs" <command>`.

## Skills

| Skill | What it does |
|---|---|
| `/p-observe:init` | Detect present plugins, resolve the p-graph CLI, write optional `.posebserve.json`. |
| `/p-observe:watch` | Launch the live stream. |
| `/p-observe:help` | Command cheat-sheet. |

## What it can and can't see

- **p-shed** — full job history (from its own log) + live launches.
- **p-tasks** — status transitions from `tasks.yml`. A **Jira-primary** tracker has no local file → invisible.
- **p-graph** — aggregate node/edge/drift deltas (needs `pgraphCli` for counts; else "db changed").
- **p-wiki** — page compiles/edits/conflicts from frontmatter. A **Confluence-primary** wiki → invisible.

See `docs/superpowers/specs/2026-07-17-p-observe-design.md` for the full design.

## Requirements

Node ≥ 18. No external dependencies.
