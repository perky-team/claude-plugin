# perky.team plugins

A Claude Code plugin marketplace. Plugins live under `plugins/<name>/`.

## Install the marketplace

Open Claude Code CLI and add this repository as a marketplace, then install any plugin from it:

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install <plugin-name>@perky.team
```

`<plugin-name>` is one of `p-wiki`, `p-flow`, `p-tasks`, `p-statusline` (see below).

From a non-GitHub git host:

```text
/plugin marketplace add https://gitlab.com/perky-team/claude-plugin.git
/plugin install p-wiki@perky.team
```

Update an installed plugin after the marketplace receives changes:

```text
/plugin marketplace update perky.team
/plugin update <plugin-name>@perky.team
```

Uninstall:

```text
/plugin uninstall <plugin-name>@perky.team
```

## Plugins

### [`p-wiki`](./plugins/p-wiki/)

Persistent markdown knowledge wiki under `docs/wiki/` of the project repo, with a bundled `pwiki` CLI. Captures external sources (URLs, files, pastes) into `raw/`, then synthesizes them into linked concept pages on demand. Answers questions with citations from accumulated project knowledge.

Skills: `init`, `ingest`, `compile`, `query`, `lint`.

### [`p-flow`](./plugins/p-flow/)

Disciplined task development flow for Claude: secrets deny-list, Conventional Commits + `<type>/<slug>` branch naming, spec templates (ADR, Gherkin, full specification), and a skill+agent stack for brainstorm → plan → verify → review → push.

Commands: `init`, `task-start`, `task-end`.
Skills: `init`, `task-brainstorming`, `writing-plan`, `verification-before-completion`, `requesting-code-review`, `requesting-task-review`.
Subagents: `code-reviewer`, `task-reviewer`.

### [`p-tasks`](./plugins/p-tasks/)

Two-level task tracker (`task` → `sub-task`) with FS and Jira destinations. One-way `primary → mirrors` sync.

Skills: `init`, `add`, `set`, `next`, `summary`, `sync`.

### [`p-statusline`](./plugins/p-statusline/)

A custom Claude Code status line — the two-line bar at the bottom of the terminal. Activated via the `install` skill, which copies the renderer script to `~/.claude/p-statusline/` and wires `statusLine` in `~/.claude/settings.json`.

The status line shows:

**Line 1 — `context | rate limits | git`**
- **Context window** — usage `%`, consumed tokens (e.g. `64k`), and cache-hit `%`. The percentage and token count share a green → red ramp that warms as the window fills. Shows a dim `-%` placeholder before the first API response.
- **Rate limits** — `5h` and `7d` usage windows side-by-side, each as `XXX%[countdown]` with reset countdown (e.g. `5h  25%[ 3h12m]`). Fixed 31-character width: percentages right-aligned, countdowns padded so the `%`, `[`, `]` landmarks line up. `n/a` (padded) until Claude Code reports data.
- **Git** — branch name (magenta), `*` for uncommitted changes, `wt:` marker inside a linked worktree, and `↑N↓M` commits ahead-of / behind upstream.

**Line 2 — `model | path | RAM`**
- **Model + effort** — bare model display name with effort level (`Opus 4.7 xhigh`).
- **Project path** — the project's launch directory. Capped at the limits-section width: if longer, truncated from the start with a `...` prefix so the folder name (end of the path) stays visible, and the second `|` separator vertically aligns with line 1.
- **RAM** — system memory usage with the same green → red ramp as the rate-limit %.

The leading segments of both lines (context / model+effort) are padded so the first `|` separator vertically aligns.

Skills: `install`.

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
│   └── p-flow/              ← task development flow + spec templates
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       ├── agents/          ← read-only review subagents
│       ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│       └── skills/
└── README.md                ← this file
```

To add a new plugin: create `plugins/<new-plugin>/` with its own `.claude-plugin/plugin.json` and skills, then add a new entry to `.claude-plugin/marketplace.json`.

## Local development

```bash
claude --plugin-dir C:/path/to/x/plugins/p-wiki
```

Each plugin can be loaded standalone for development with `--plugin-dir`.
