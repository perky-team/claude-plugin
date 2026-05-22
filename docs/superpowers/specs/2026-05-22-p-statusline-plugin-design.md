# p-statusline plugin — design

**Date:** 2026-05-22
**Scope:** add a fourth plugin, `p-statusline`, to the `perky.team` marketplace. It packages the author's existing Claude Code status line so other people can install it. The status line script is ported from a bash-wrapped `node -e` one-liner to a standalone Node.js file. A skill, `/p-statusline:init`, wires it into the user's `~/.claude/settings.json`. No behaviour change to the status line itself.

## Background

The author runs a custom status line configured in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "bash '/c/Users/suhar/.claude/statusline-command.sh'" }
```

`statusline-command.sh` is a `#!/usr/bin/env bash` file whose entire body is `exec node -e '<inline JS>'`. The inline JS reads the session JSON on stdin and prints a two-line ANSI status line: context %/tokens/cache %, rate limits (5h/7d with reset countdowns), git (branch, dirty flag, worktree marker, ahead/behind), TodoWrite progress, model/effort, RAM %, and the project path.

The goal is to distribute this exact status line as an installable Claude Code plugin.

## Key constraint (researched)

A Claude Code plugin **cannot directly own the main status line**. A plugin's root `settings.json` supports only the `agent` and `subagentStatusLine` keys — the official docs state: *"Only the `agent` and `subagentStatusLine` keys are currently supported."* The main `statusLine` key is not among them.

Therefore activation cannot be automatic on plugin-enable. The plugin ships the script and provides an **install skill** that writes the `statusLine` block into the user's `~/.claude/settings.json` — the same `init`-skill pattern already used by `p-flow`, `p-wiki`, and `p-tasks`.

Two further researched facts shape the design:

- **`${CLAUDE_PLUGIN_ROOT}` is not substituted in user `settings.json`.** That variable is expanded only in hook / MCP / LSP / monitor command configs, not in a `statusLine.command` string in `~/.claude/settings.json`. The install skill must therefore write a fully resolved absolute path.
- **The plugin install path changes on every update** (`.../cache/.../p-statusline/<version>/...`), and the old directory is cleaned up ~7 days later. Pointing `settings.json` straight at a file inside the plugin would break on the next update. The script must be copied to a stable, user-owned location.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | Fourth plugin, `plugins/p-statusline/`, in this marketplace. |
| Activation | A skill installer, `/p-statusline:init`. |
| Runtime | Pure Node.js (`node ".../statusline.cjs"`) — drops the bash dependency. |
| Update strategy | Skill copies the script to a stable path (`~/.claude/p-statusline/`); re-run the skill to pick up a newer version. |
| Configurability | None. The status line ships exactly as-is — all segments always on. |
| Install scope | User scope (`~/.claude/settings.json`) — a status line is a personal, global setting. |

## Plugin layout

```
plugins/p-statusline/
├── .claude-plugin/
│   └── plugin.json              # name: p-statusline, version: 0.1.0, description, author
├── README.md                    # install / segment reference / requirements / removal
├── statusline/
│   └── statusline.cjs            # the ported status line script (pure Node, no bash)
└── skills/
    └── init/
        └── SKILL.md             # /p-statusline:init — the installer
```

`statusline.cjs` lives at the plugin root under `statusline/`, **not** under `skills/_shared/templates/`. The repo's `templates.test.ts` only inspects `skills/_shared/templates/` and would otherwise demand a `${CLAUDE_SKILL_DIR}/../_shared/templates/...` reference for the file. Keeping it under `statusline/` avoids that coupling and lets the test suite import it by a plain path.

## Component: `statusline/statusline.cjs`

A mechanical port. The current `.sh` file is `exec node -e '<JS>'`; the port lifts that exact JS body into a standalone `statusline.cjs`. **No logic changes** — same segments, same colours, same graceful degradation (every block is wrapped in `try/catch`; on any failure the script prints an empty line or a partial line).

The script is already self-contained: it takes the cwd and transcript path from the stdin JSON, shells out to `git`, and reads RAM via `node:os`. Nothing is hard-coded to the author's machine. `node`, `fs`, `os`, and `child_process` are all built-ins — no `npm install`, no dependencies.

The resulting status line command becomes:

```json
"statusLine": { "type": "command", "command": "\"<node>\" \"<home>/.claude/p-statusline/statusline.cjs\"" }
```

## Component: skill `/p-statusline:init`

Frontmatter: `name: init`, a `description` covering the trigger phrases ("init p-statusline", "install statusline", "setup status line"), `argument-hint: (no arguments)`, and an `allowed-tools` list (`Bash`, `Read`, `Write`).

The skill writes to the **user** settings file, `~/.claude/settings.json`, resolved cross-platform from `$HOME` / `%USERPROFILE%`. Hereafter `<home>` = the resolved home directory.

**Step 1 — Resolve home.** Determine `<home>`. If it cannot be resolved, stop with a clear error.

**Step 2 — Resolve the `node` binary.** Run `where node` (Windows) / `which node` (POSIX). If found, capture the absolute path as `<node>`. If not found, fall back to the bare string `node` and warn the user that the status line will only work if `node` is on `PATH` (a status line set by the native-installer build of Claude Code may otherwise silently print nothing).

**Step 3 — Copy the script.** `mkdir -p <home>/.claude/p-statusline/`. Copy `${CLAUDE_PLUGIN_ROOT}/statusline/statusline.cjs` to `<home>/.claude/p-statusline/statusline.cjs`, overwriting any existing copy (this is how a re-run picks up a newer plugin version). If the source file cannot be read, stop and tell the user the plugin install may be corrupted.

**Step 4 — Read the settings file.** Read `<home>/.claude/settings.json`.
- Missing → treat as `{}` (will be created in Step 6).
- Present but not valid JSON → **stop** with: "Cannot proceed: `<home>/.claude/settings.json` is not valid JSON. Fix it manually and re-run `/p-statusline:init`." (Mirrors `p-flow:init`.)
- Present but the parsed root is not an object → stop with an equivalent error.

**Step 5 — Protect an existing status line.** Compute the target command string: `"<node>" "<home>/.claude/p-statusline/statusline.cjs"`.
- If `statusLine` is absent → proceed.
- If `statusLine` already points at our script (`...p-statusline/statusline.cjs`) → report "p-statusline is already installed" and still rewrite the command (so a moved home or a changed `<node>` path is corrected). Idempotent.
- If `statusLine` exists and is something else → save the existing value to `<home>/.claude/p-statusline/statusline.prev.json` and warn the user that their previous status line was replaced and where the backup is.

**Step 6 — Write the settings file.** Set `statusLine` to `{ "type": "command", "command": "<target command>" }`. Preserve every other key untouched (`{ ...existing }` spread, exactly as `p-flow:init` does for `permissions`). Write with 2-space indentation and a trailing newline. If the file did not exist, create it with just the `statusLine` key.

**Step 7 — Final message.** Tell the user: the script path, whether the settings file was created or merged, whether a previous status line was backed up, and that they must **restart Claude Code** for the status line to appear.

### Edge cases

- `~/.claude/settings.json` invalid JSON → stop (Step 4).
- Root JSON is not an object → stop (Step 4).
- `statusline.cjs` source unreadable → stop, "plugin install may be corrupted" (Step 3).
- `node` not on `PATH` → proceed with bare `node`, warn (Step 2).
- `mkdir` / write fails (permissions) → stop, show the exact shell error.
- Re-run after a plugin update → Step 3 overwrites the copy, Step 5 detects "already installed", command is refreshed. Safe.

## Manifest, marketplace, and READMEs

- **`plugin.json`** — `name: "p-statusline"`, `version: "0.1.0"`, a `description`, and `author` (`Andrey Sukharev`). Same shape as the sibling plugins. The directory name, `plugin.json` `name`, and the marketplace entry `name` must all be exactly `p-statusline` (kebab-case) — three repo tests assert this agreement.
- **`.claude-plugin/marketplace.json`** — add a fourth `plugins[]` entry: `{ name, source: "./plugins/p-statusline", description }`.
- **Root `README.md`** — add a `p-statusline` row to the `| Plugin | What it does |` table. `marketplace.test.ts` asserts every marketplace plugin appears in that table.
- **`plugins/p-statusline/README.md`** — install steps (`/plugin install` → `/p-statusline:init`), a table of what each segment shows and how the colour ramps read, the requirement (Node.js — present wherever Claude Code runs), and **manual removal** (delete the `statusLine` block from `~/.claude/settings.json`, remove `~/.claude/p-statusline/`). Must be >50 chars (`plugin-manifests.test.ts`).

## Testing

Aligned with the existing suite (`tests/`, Vitest, `helpers.ts`).

**Inherited, no new code.** `marketplace.test.ts`, `plugin-manifests.test.ts`, and `skills.test.ts` iterate every plugin via `findPlugins()` / `findSkills()`. `p-statusline` is picked up automatically and must satisfy: valid manifest, kebab-case semver-versioned name matching the directory, a >50-char README, at least one skill, and a well-formed `init/SKILL.md` (frontmatter `name` = `init`, `description` >30 chars, body >100 chars). `templates.test.ts` does nothing here — there is no `skills/_shared/templates/` directory.

**`tests/p-statusline-statusline.test.ts` (new).** Spawns `node plugins/p-statusline/statusline/statusline.cjs`, pipes fixture session JSON to stdin, and asserts the output **per segment**:
- full data — context, limits, model/effort all present;
- no `rate_limits` — limits segment falls back to `5h n/a 7d n/a`;
- cwd is not a git repository — git segment absent;
- detached HEAD — git segment shows the short hash;
- no `transcript_path` — task progress shows the `▸ 0/0` default.

Volatile segments (RAM %, live git state, reset countdowns) are matched by structure / regex, not byte-for-byte.

**`tests/p-statusline-init-e2e.test.ts` (new).** Follows the `p-flow-init-e2e.test.ts` pattern: re-implements the `init` algorithm (copy script + merge `statusLine` into `settings.json`) against a temp HOME directory, acting as an executable spec. Cases:
- no `settings.json` → file created with only `statusLine`;
- existing `settings.json` with unrelated keys → those keys preserved, `statusLine` added;
- existing foreign `statusLine` → previous value backed up to `statusline.prev.json`;
- already pointing at our script → idempotent, no duplication;
- invalid JSON → throws;
- root JSON not an object → throws;
- the script is copied to `<home>/.claude/p-statusline/statusline.cjs`.

## Out of scope (YAGNI)

- Segment toggles or any user configuration — the status line ships fixed.
- A SessionStart hook that auto-refreshes the copied script when the plugin updates — re-running `/p-statusline:init` is the documented update path.
- A `remove` / uninstall skill — removal is documented in the README.
- Project-scope installation (`.claude/settings.json`) — user scope only.

## Release note

Per the repo's `.claude/CLAUDE.md` release rule, adding a new plugin is a **minor** bump, applied to `plugins/p-wiki/.claude-plugin/plugin.json#version`, tagged on push. `p-statusline`'s own `plugin.json` starts at `0.1.0`. This is a push-time step, not part of the build.
