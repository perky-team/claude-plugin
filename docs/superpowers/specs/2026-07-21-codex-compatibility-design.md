# Codex CLI compatibility — design spec

**Date:** 2026-07-21
**Status:** draft (spec only — no implementation yet)
**Scope:** repo-wide (all plugins + the marketplace layer)

## Summary

This repo is a **Claude Code plugin marketplace**: a `.claude-plugin/marketplace.json`
listing six plugins, each with a `.claude-plugin/plugin.json` manifest, `skills/`,
optional `hooks/`, bundled Node CLIs under `tools/`, and templates.

OpenAI's **Codex CLI** has, since its 2026-03-26 marketplace launch, adopted a plugin
model that is deliberately close to Claude Code's — same `SKILL.md` skill format, the
same `hooks.json` shape and lifecycle events (including `SessionStart`), and even
`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` environment variables passed to hooks "for
legacy compatibility". The official docs state the skill format "is converging across
vendors — the same `SKILL.md` file works with Codex, Gemini CLI, and Claude Code".

Because of that convergence, making these plugins install and run under **both** Claude
Code and Codex is mostly a **packaging-and-wiring** exercise, not a rewrite. The skill
bodies, hook scripts, bundled CLIs, and templates are shared; only a thin per-platform
manifest layer is duplicated, plus one genuinely different subsystem (subagent
dispatch in `p-flow`) and one plugin that cannot port (`p-statusline`).

This document specifies the target state and the work required. It intentionally stops
short of implementation.

## Goals

- One repository that publishes the same plugins to Claude Code **and** Codex CLI.
- A **single source of truth** for anything shared; per-platform manifests are
  **generated**, not hand-maintained, with a test that fails on drift.
- No regression for Claude Code users: the existing `.claude-plugin/*` layer and
  behavior stay byte-for-byte unchanged.

## Non-goals (explicitly out of scope)

- **No implementation in this change.** Spec only; a follow-up plan drives the work.
- **No Codex-native rewrite.** We do not fork the repo into TOML-first Codex idioms;
  we add a compatibility layer alongside the Claude-native one.
- **No behavior change to any plugin's runtime logic** beyond what is strictly needed
  to run outside Claude Code (tool-name wording, argument fallback).
- **No attempt to port `p-statusline`'s custom-script status line** — Codex has no
  command-backed status line (see "Plugins that cannot port").

## Background — verified Codex facts

Collected 2026-07-21 from official docs (`learn.chatgpt.com/docs/*`,
`developers.openai.com/codex/*`) and cross-checked against the Codex knowledge base.
Codex evolves fast — re-verify against the target `codex` version before implementing.

| Area | Claude Code (this repo) | Codex CLI |
|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` (does **not** read `.claude-plugin/`) |
| Manifest fields | name, version, description, author | name, version, description, optional author/homepage/repository/license/keywords/interface + component paths |
| Marketplace manifest | `.claude-plugin/marketplace.json`; `plugins[].source` is a **string** path + `description` | `marketplace.json` at repo root **or** `.agents/plugins/marketplace.json`; `plugins[].source` is an **object** `{source:"local", path:"./..."}` + `policy`, `category`, `interface` |
| Skill format | `skills/<name>/SKILL.md`, frontmatter `name`/`description`/`argument-hint`/`allowed-tools` | `skills/<name>/SKILL.md`, frontmatter **only** `name`/`description` read (extras ignored); optional per-skill `agents/openai.yaml` |
| Skill invocation | `/p-wiki:compile $ARGUMENTS` (namespaced slash command) | implicit by `description`, or explicit `$compile`; **no** `plugin:skill` namespace; `$ARGUMENTS` not substituted for a skill |
| Loose skills dir | `.claude/skills/` | `.agents/skills/` (also `$HOME/.agents/skills`, `/etc/codex/skills`) |
| Hooks file | `hooks/hooks.json` | `hooks.json` (identical JSON shape) or inline `[[hooks.Event]]` in `config.toml` |
| Hook events | SessionStart, PreToolUse, PostToolUse, … | SessionStart, SubagentStart, PreToolUse, PermissionRequest, PostToolUse, Pre/PostCompact, UserPromptSubmit, SubagentStop, Stop |
| Hook env vars | `${CLAUDE_PLUGIN_ROOT}` | `PLUGIN_ROOT`, `PLUGIN_DATA`, **and** `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` (legacy compat) |
| Subagents | inline `.md` templates dispatched via **Task tool** (`subagent_type: general-purpose`); cross-plugin calls via **Skill tool** | `.codex/agents/*.toml` (`developer_instructions`, `model`, `sandbox_mode`, `mcp_servers`), registered in `config.toml`; **no** Task/Skill tool |
| Tool names | Read/Write/Edit/Bash/Grep/Glob/Task/Skill | `shell`, `apply_patch`, MCP tools |
| Project rules | `CLAUDE.md`, `.claude/rules/*.md`, `.claude/settings.json` | `AGENTS.md` (global/root/nested), `~/.codex/config.toml` |
| Status line | custom shell script via `.claude/settings.json#statusLine` | fixed built-in items via `[tui] status_line`; **no** custom script (feature request openai/codex#20140) |
| Custom prompts | n/a | `~/.codex/prompts/*.md` → `/prompts:name`, **deprecated** in favor of skills |
| Install | Claude Code marketplace | `codex marketplace add <org/repo>` (`@branch`/`#tag`), `/plugin install`, `/reload-plugins` |

## Approach — dual-manifest single repo

Chosen over (B) a separate `dist-codex/` build output and (C) a Codex-native fork.
Rationale: the packaging layers are near-identical and Codex keeps deliberate Claude
compatibility, so ~80% is already shared. A generated compatibility layer keeps one
source of truth and concentrates real effort on the one subsystem that truly differs.

Three tiers of work:

### Tier 1 — Shared, no change (verify only)

- `skills/**/SKILL.md` **bodies** — reusable as-is.
- `hooks/hooks.json` and hook scripts — Codex uses the same JSON shape, `SessionStart`
  exists, and `${CLAUDE_PLUGIN_ROOT}` is supported via legacy env compat. **Verify**
  the polyglot `run-hook.cmd`/`session-start` wrapper runs under Codex's shell.
- Bundled Node CLIs (`pwiki.mjs`, `ptasks.mjs`, `pgraph.mjs`, `pshed.mjs`) — plain
  Node invoked via the shell; harness-neutral already.
- Templates under `skills/_shared/templates/`.

### Tier 2 — Generated compatibility layer (mechanical, single source of truth)

- Per plugin: a `.codex-plugin/plugin.json` alongside `.claude-plugin/plugin.json`
  (same name/version/description/author). Everything else stays at the plugin root —
  both systems expect that.
- A Codex marketplace manifest mirroring `.claude-plugin/marketplace.json` but in Codex
  schema (`source` object, `policy`, `category`). Location to confirm: repo-root
  `marketplace.json` vs `.agents/plugins/marketplace.json`.
- A generator in `scripts/` that derives the Codex manifests from the Claude manifests,
  plus a vitest that fails when they drift (fits the repo's test-invariant culture).
  Editing stays single-source: change the Claude manifest, regenerate.

### Tier 3 — Genuinely different (manual logic work)

- **`p-flow` subagent dispatch (the main effort).** The inline reviewer/implementer
  templates (`requesting-code-review/code-reviewer.md`, `requesting-task-review/
  task-reviewer.md`, `task-brainstorming/spec-auditor.md`, `subagent-driven-development/
  implementer-prompt.md` + `task-reviewer-prompt.md`) are dispatched via the Task tool,
  which Codex lacks. Under Codex they become `.codex/agents/*.toml` whose
  `developer_instructions` is the template body — both derived from one source. Confirm
  whether a **plugin can bundle** `agents/*.toml` as a distributable component or only
  user-level `.codex/agents/` is read (open question below).
- **Cross-plugin bridges.** `p-flow`'s Skill-tool calls into `p-tasks`/`p-wiki`
  (`p-tasks:add`, `p-wiki:compile`) have no Codex equivalent. Under Codex, fall back to
  invoking the bundled CLI directly (`node ptasks.mjs add …`) — harness-neutral and
  already present. The Claude path (Skill tool) is retained; the bridge doc gains a
  Codex branch.
- **Skill body wording.** Where a body hard-codes a Claude tool name in an imperative
  ("use the Read tool") or relies on `$ARGUMENTS`, make it harness-neutral ("read the
  file"; add an explicit empty-argument fallback). `allowed-tools`/`argument-hint`
  frontmatter can stay — Codex ignores it harmlessly.
- **Rule install (`init` skills).** `p-flow`/`p-wiki`/`p-tasks`/`p-graph` `init` skills
  write `CLAUDE.md`, `.claude/rules/*.md`, `.claude/settings.json`. Codex reads
  `AGENTS.md` + `config.toml`. `init` should also emit `AGENTS.md`-targeted rules (and
  a `config.toml` snippet where a rule maps to config), gated by which harness is
  running or written for both.

## Plugins that cannot port

- **`p-statusline`.** Codex's status line is a fixed set of built-in items
  (`[tui] status_line`), with no command-backed custom-script model (openai/codex#20140
  is still open). The custom `statusline.cjs` cannot run. Options: (a) omit the plugin
  from the Codex marketplace listing, or (b) ship a best-effort `install` that only
  writes a `[tui] status_line = [...]` snippet into `config.toml`. Decision deferred to
  the implementation plan; default is (a).

## Per-plugin impact summary

| Plugin | Manifest | Skills body edits | Subagents | Rule install | Status |
|---|---|---|---|---|---|
| p-wiki | +`.codex-plugin` (gen) | tool-name/arg wording | none | +AGENTS.md target | ports |
| p-tasks | +`.codex-plugin` (gen) | tool-name/arg wording | none | +AGENTS.md target | ports |
| p-graph | +`.codex-plugin` (gen) | tool-name/arg wording | none | +AGENTS.md target | ports |
| p-shed | +`.codex-plugin` (gen) | verify `claude -p` launch semantics vs `codex` | none | n/a (no rule) | ports (launcher target may need a Codex mode — follow-up) |
| p-flow | +`.codex-plugin` (gen) | wording + bridges | **TOML agents** (main work) | +AGENTS.md target | ports (largest effort) |
| p-statusline | — | — | — | `config.toml` `[tui]` only | **does not port** |

## Open questions (resolve during planning)

1. Can a Codex **plugin bundle** `agents/*.toml` as a distributable component, or are
   custom agents only read from user/project `.codex/agents/`? Sources conflict. This
   decides whether `p-flow`'s reviewers ship inside the plugin or must be installed
   separately.
2. Exact location Codex expects the marketplace manifest for a monorepo: repo-root
   `marketplace.json` vs `.agents/plugins/marketplace.json`. Confirm on the target
   `codex` version.
3. Does `p-shed` (a launcher of `claude -p`) need a parallel Codex mode that launches
   `codex exec`/headless, or is it Claude-only by nature? Likely a separate follow-up.
4. Whether to gate dual behavior at **runtime** (detect harness) or ship **both** static
   artifacts and let each tool pick its own. Default: ship both static artifacts (no
   fragile runtime detection).

## Testing strategy (for the future implementation, not now)

- Manifest-sync test: generated `.codex-plugin/plugin.json` and the Codex marketplace
  manifest match their Claude sources (fails on drift).
- Schema test: each `.codex-plugin/plugin.json` is valid Codex manifest JSON; the Codex
  marketplace `source` objects point at existing plugin roots with `./`-relative paths.
- Body-neutrality lint: no SKILL.md body issues a Claude-only tool-name imperative in a
  step that Codex would execute (best-effort string check).
- Existing Claude-side tests stay green unchanged (no regression).

## Acceptance (of this spec)

- The spec is committed under `docs/superpowers/specs/`.
- It records the verified Codex facts, the chosen approach (dual-manifest single repo),
  per-plugin impact, what cannot port, and the open questions.
- No plugin files are modified; no manifests are generated yet.

## Sources

- Plugins — https://learn.chatgpt.com/docs/plugins
- Build skills — https://learn.chatgpt.com/docs/build-skills
- Hooks — https://learn.chatgpt.com/docs/hooks
- Custom prompts (deprecated) — https://learn.chatgpt.com/docs/custom-prompts
- Advanced config — https://learn.chatgpt.com/docs/config-file/config-advanced
- Marketplace distribution — https://codex.danielvaughan.com/2026/04/11/codex-marketplace-plugin-distribution/
- Plugin system — https://codex.danielvaughan.com/2026/03/30/codex-cli-plugin-system/
- Status line feature request — https://github.com/openai/codex/issues/20140
