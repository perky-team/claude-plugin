# perky.team plugins

A Claude Code plugin marketplace. Plugins live under `plugins/<name>/`.

## Plugins

| Plugin | What it does |
|---|---|
| [`p-wiki`](./plugins/p-wiki/) | Persistent markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`. |
| [`p-flow`](./plugins/p-flow/) | Workflow rules for Claude: secret-file deny-permissions, Conventional Commits + `<type>/<slug>` branches, spec templates. Skills: `init`. |
| [`p-tasks`](./plugins/p-tasks/) | Two-level task tracker (`task` → `sub-task`) with FS and Jira destinations, one-way primary→mirrors sync. Skills: `init`, `add`, `set`, `next`, `summary`, `sync`. |
| [`p-statusline`](./plugins/p-statusline/) | Custom Claude Code status line — context %, rate limits with reset countdowns, git, task progress, model/effort, RAM. Skills: `install`. |

## Install

After this repo is published at `perky-team/claude-plugin` (or wherever) on GitHub:

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-wiki@perky.team
```

From a non-GitHub git host:

```text
/plugin marketplace add https://gitlab.com/perky-team/claude-plugin.git
/plugin install p-wiki@perky.team
```

## Tests

Static validation of `marketplace.json`, every `plugin.json`, every `SKILL.md`, and template references.

```bash
npm install   # first time only
npm test
```

Tests are static — no network, no `claude` CLI, no fixtures. See [`docs/superpowers/specs/2026-05-12-marketplace-tests-design.md`](./docs/superpowers/specs/2026-05-12-marketplace-tests-design.md) for the rationale.

## Validate

Run Claude Code's own validator on the marketplace and every plugin. Requires the `claude` CLI on PATH.

```bash
npm run validate
```

Complements `npm test`: tests catch structural drift in our manifests/skills, `validate` catches whatever the `claude` CLI itself rejects.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json     ← catalog of plugins in this marketplace
├── plugins/
│   ├── p-wiki/              ← one directory per plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│   │   └── skills/
│   └── p-flow/              ← workflow rules + spec templates
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       └── skills/
└── README.md                ← this file
```

To add a new plugin: create `plugins/<new-plugin>/` with its own `.claude-plugin/plugin.json` and skills, then add a new entry to `.claude-plugin/marketplace.json`.

## Local development

```bash
claude --plugin-dir C:/path/to/x/plugins/p-wiki
```

Each plugin can be loaded standalone for development with `--plugin-dir`.
