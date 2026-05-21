# Marketplace ↔ Superpowers Integration — Design

**Date:** 2026-05-21
**Scope:** overarching design for transparent integration of `p-wiki`, `p-tasks`, `p-flow` with the third-party `superpowers` plugin.
**Status:** Proposed.

---

## Goal

Make the three marketplace plugins (`p-wiki`, `p-tasks`, `p-flow`) work as a coherent extension of `superpowers`, so that:

- Spec artifacts produced by `superpowers:brainstorming` are searchable through `p-wiki` without manual intervention.
- Plan artifacts produced by `superpowers:writing-plans` are tracked as feature-level tasks in `p-tasks` without duplicating plan steps.
- A repo following all three plugins behaves uniformly across sessions and across agents/subagents dispatched by `superpowers:subagent-driven-development`.

**Non-goal:** modifying or forking `superpowers`. All integration must happen outside its plugin cache and survive its upgrades.

---

## Motivation

`superpowers` produces two artifact streams during normal use:

- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (from `brainstorming`)
- `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` (from `writing-plans`)

As a repo accumulates dozens of these files, three pain points emerge:

1. **Context overflow.** When agents implement features they read whole specs/plans; with N≥20 artifacts, the relevant subset is not obvious, and loading all of them exhausts context budget.
2. **No persistent feature-level tracking.** `superpowers` uses ephemeral session-level todos (`TaskCreate` / `TodoWrite`) for in-session work, but offers nothing for cross-session "which feature is in progress, which is blocked, which is done at the team level".
3. **Conventions live in the team's heads, not in the repo.** Secret-file deny-permissions, commit/branch conventions, and ADR/feature-file templates are valuable but not part of `superpowers`.

The three plugins address these three pain points respectively. The integration design below ensures they do so **transparently** (no manual handoff between superpowers and marketplace skills) and **safely** (no automatic LLM-grade work without user intent).

---

## Architectural principles

These principles drive every decision below. Trade-offs are revisited against them when alternatives are evaluated.

1. **Never load the whole corpus.** Read a thin index at the top of every session; drill down only into artifacts relevant to the current task.
2. **Self-contained plugins.** Each plugin ships its own hooks and rules. Installing the plugin activates its contribution. Plugins do not assume the others are installed.
3. **Read enrichment via SessionStart; write effects via slash commands.** Hooks inject context cheaply and deterministically. Expensive LLM-grade work (compile, query, task synthesis) is initiated by the user or by Claude under rule guidance — never silently in the background.
4. **Superpowers is read-only from our side.** We watch its outputs, never modify its inputs or behaviour. Its plugin cache stays untouched.
5. **Honesty over magic.** When a guarantee is "Claude usually does X", say so. Don't pretend rule-driven actions are as deterministic as hooks.

---

## Read-layer architecture

How information flows into Claude's context, ordered by cost:

| Layer | Mechanism | Token cost | When |
|---|---|---|---|
| **0 — rules** | `.claude/rules/*.md` auto-loaded | ~500 tokens per rule, every turn | Always present |
| **1 — session map** | `SessionStart` hook injects `wiki/index.md` summary + `/p-tasks:summary` output via `hookSpecificOutput.additionalContext` | ~1k tokens, once per session | Session boot |
| **2 — drill-down** | Targeted `Read` of one `plan_path` or 1–3 concept pages | 5–15k tokens per artifact | When task identified |
| **3 — subagent isolation** | `superpowers:subagent-driven-development` dispatches subagents with curated context | Per-subagent budget, parallel-safe | During implementation |
| **4 — wiki query (on demand)** | `/p-wiki:query "<topic>"` — LLM picks 1–3 concept pages from `index.md`, reads them, returns with citations | Variable; one LLM call per query | When index lookup isn't enough |

The design intent: a repo with 50 features should consume the same controller context as a repo with 5, because the controller only ever sees the layer-1 map. Subagents see only their slice.

---

## Plugin: p-wiki

### Role

Indexed markdown knowledge base under `docs/wiki/`. Compile-target for `superpowers` spec/plan artifacts and for the team's existing documentation. Source of layer-1 navigation (`index.md`) and layer-4 query.

### What changes

1. **New optional config field:** `.pwiki.json` gains a `"mode"` field (`staging` | `recommended` | `primary`), modelled on `llm-wiki-compiler`'s convention. Default `recommended`. Controls how aggressive the SessionStart injection is.
2. **`hooks/hooks.json` — SessionStart only.** No PostToolUse hook in default config. The hook:
   - Reads `docs/wiki/index.md`, emits its TOC as `hookSpecificOutput.additionalContext`.
   - Runs `find docs/superpowers/specs docs/superpowers/plans -newer <last-compile-marker>` and, if any sources are newer than the last successful compile, appends a stale-warning paragraph: "Wiki may be stale: N spec/plan files have changed since last compile. Run `/p-wiki:compile` to refresh."
   - Marks the injection with a uniquely identifiable header (e.g. `<!-- p-wiki:session-context -->`) so duplicate injection across plugins is detectable.
   - Uses official `hookSpecificOutput.additionalContext` shape, not `systemMessage` (the `task-tracker-plugin` mistake).
   - Silently exits 0 if `docs/wiki/` does not exist (plugin installed but not initialised) or if Node CLI is missing.
3. **New optional skill: `/p-wiki:bootstrap`.** First-run helper for existing repos. Globs `README*`, `docs/**`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `*.feature`, `docs/adr/**`, existing `docs/superpowers/specs/**` and `docs/superpowers/plans/**`. Presents the list to the user, asks "compile all / select / skip", then calls `/p-wiki:compile` in a loop.
4. **No code compilation.** `compile` continues to accept any path technically, but `/p-wiki:bootstrap` excludes code files. Documentation explicitly states: compile is for doc-like sources (spec, plan, ADR, feature, README, docs/), **not** for source code. See "Not doing" below.
5. **Existing `compile`, `query`, `lint`, `ingest`, `init` stay as is** with one update: `compile` now writes a marker file (e.g. `docs/wiki/.last-compile`) on successful completion, so the SessionStart stale-check has a reference.

### Why no PostToolUse hook for auto-compile (in default config)

Two prior-art findings drove this:

- `task-tracker-plugin` has a PostToolUse Edit|Write hook and its own author's refactoring plan explicitly recommends removing it as "low value, complicates architecture".
- `llm-wiki-compiler` (265 stars, mature) deliberately does not auto-compile on writes. Compile is always an explicit `/wiki-compile`.

Auto-compile via hook means a silent multi-minute LLM operation triggers every time `superpowers:brainstorming` writes a spec. Token cost is hidden, conflicts with `superpowers`'s own PostToolUse hooks (v4.3.0 uses them for gate-enforcement) are possible, and user loses control over when LLM work happens.

Instead, compile is invoked:
- Explicitly by the user via `/p-wiki:compile`.
- By Claude following a rule in `p-flow:rules` ("after `superpowers:brainstorming` writes a spec, run `/p-wiki:compile <path>`"). Compliance is ~95%, not 100%.
- Pulled by the stale-warning at next SessionStart if Claude missed a step. The warning is the safety net.

Power users can opt into PostToolUse autocompile by setting `"autocompile": true` in `.pwiki.json` — but it's off by default. (Future enhancement, not v1.)

---

## Plugin: p-tasks

### Role

Feature-level persistent task tracker. **Not** a step-level tracker — steps belong in `plan.md`. One task per feature; `spec_path` and `plan_path` link to superpowers artifacts.

### What changes

1. **Schema:** add optional `spec_path` and `plan_path` string fields to both `task` and `sub-task` in `tools/lib/schema.mjs`. Validator treats them as opaque relative paths from repo root. No structural change otherwise.
2. **New skill: `/p-tasks:from-plan <path>`.** Creates a top-level task from a superpowers plan file. Parses the plan header to extract feature name (from `# <Feature> Implementation Plan`) and optionally a `Spec:` reference for `spec_path`. Returns the new task id. Fails with explicit error if the file isn't recognisable as a superpowers plan.
3. **New skill: `/p-tasks:link-plan <task-id> <path>`.** Attaches a `plan_path` to an existing task. Used when the task was created from a spec earlier and a plan was written later — though in the v1 flow, `from-plan` is the primary entry point. `link-plan` is the manual escape hatch.
4. **`hooks/hooks.json` — SessionStart only.** Runs `node tools/ptasks.mjs summary --format=json`, emits a compact "active tasks: t-3 (in_progress, blocked by t-1), t-5 (todo) …" string as `hookSpecificOutput.additionalContext`. Silently exits 0 if `docs/tasks/` doesn't exist or Node CLI missing.
5. **No PostToolUse hook in default config.** Same rationale as p-wiki. Task creation is initiated by Claude under rule guidance, not silently.
6. **Updated `_shared/templates/p-tasks.rule.md.tpl`:** mention that tasks correspond to features (not steps), that `spec_path`/`plan_path` link to superpowers artifacts, and that sub-tasks decompose features into sub-features (not steps).
7. **Updated `_shared/templates/CLAUDE.md.tpl`:** same clarifications for files inside `docs/tasks/`.

### Why not "every step of the plan becomes a sub-task"

This was considered and rejected during brainstorming. Three reasons:

- **Duplication with `plan.md`.** Steps have code, exact commands, file paths. Putting them in `description` duplicates `plan.md`; over time the two drift and the source of truth is unclear.
- **Linear steps make blockers meaningless.** Within a single feature plan, step N always blocks step N+1. Encoding this as `blockedBy` adds maintenance without insight.
- **Scaling.** Five features × 10 steps each = 50 sub-tasks for what is mentally five things. `next` and `summary` become noisy.

Feature-level granularity preserves the value `p-tasks` adds (cross-feature blockers, navigation, persistent progress) without competing with `plan.md`.

---

## Plugin: p-flow

### Role

Coordinator and convention layer. Owns: security `permissions.deny`, Conventional Commits / branch-naming rules, the rule fragment that orchestrates how Claude uses `p-wiki` and `p-tasks` alongside `superpowers`.

### What changes

1. **Drop the custom `specs/<feature-slug>/` layout.** Templates (`adr.template.md`, `feature-spec.template.feature`, `specification.template.md`) move conceptually under `docs/superpowers/specs/<slug>/` — they become **optional sibling files** to the `superpowers:brainstorming` design doc, in the same directory. The rule file documents this layout so Claude places them correctly when generating ADR/feature artifacts. The `specification.md` template can be deprecated or kept as an alternative for non-superpowers projects (decision deferred to implementation).
2. **`hooks/hooks.json` — empty by default in v1.** p-flow does not ship hooks; it ships rules. Each peer plugin owns its own hooks.
3. **Rewritten `_shared/templates/rules-p-flow.template.md`:** new sections beyond current content.
   - **Spec workflow:** after `superpowers:brainstorming` writes a spec, run `/p-wiki:compile <path>` (if p-wiki is installed) so the spec becomes searchable. Before answering implementation questions about a topic, consult `docs/wiki/index.md` and read relevant concept pages.
   - **Plan workflow:** after `superpowers:writing-plans` writes a plan, run `/p-tasks:from-plan <path>` (if p-tasks is installed) to create a tracking task. Before starting implementation, run `/p-tasks:next` to pick the active task.
   - **Task lifecycle:** when starting work on a task, run `/p-tasks:set <id> --status in_progress`. When the plan completes, run `/p-tasks:set <id> --status done`. These are rules, not hooks — best-effort, not guaranteed.
   - **Decomposition rule:** if a plan exceeds N logical Tasks (N=10 suggested) or a spec covers multiple independent subsystems, stop and propose decomposition into sub-features (each gets its own spec + plan + task) rather than writing one mega-plan.
   - **Wiki-first reading:** when implementing a task, read `docs/wiki/index.md` and any concept pages it points to **before** reading raw spec/plan files. Concept pages are compact; raw files are the deep dive.
   - **Honest security caveat:** the deny-list in `settings.json` blocks Read/Edit/Write tool calls only. `Bash` can technically bypass it. Do not rely on the deny-list as the only line of defence for secrets; use environment variables or a secret manager.
4. **`p-flow:init` script:** detects which peer plugins are installed (probe for `docs/wiki/` and `docs/tasks/` or for plugin cache markers) and writes only the relevant glue sections into the project rule file. Sections referencing absent plugins are commented out with a one-line note "uncomment if you install p-wiki later".

### Why the rule lives in p-flow, not in each peer plugin

Each peer plugin (`p-wiki`, `p-tasks`) provides its own minimal rule file describing its commands (as today). The **cross-plugin orchestration logic** — "when superpowers writes X, call p-wiki Y, then p-tasks Z" — is a concern of the convention layer. Centralising it in `p-flow` means:

- Users who don't install `p-flow` get the individual plugins working but without auto-orchestration. Acceptable composability.
- Updates to the orchestration protocol happen in one place.
- p-wiki and p-tasks remain agnostic of each other; they're glued together by p-flow rules.

---

## Layout decisions summary

| Artifact | Location | Owner |
|---|---|---|
| Design doc (from brainstorming) | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | superpowers (unchanged) |
| Plan (from writing-plans) | `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` | superpowers (unchanged) |
| ADR (optional, p-flow template) | `docs/superpowers/specs/<slug>/adr.md` (sibling to design doc) | p-flow template, hand-authored |
| Feature file (optional, p-flow template) | `docs/superpowers/specs/<slug>/feature.feature` (sibling to design doc) | p-flow template, hand-authored |
| Wiki | `docs/wiki/` | p-wiki |
| Wiki concept pages | `docs/wiki/pages/concept/<slug>.md` | p-wiki compile |
| Wiki index | `docs/wiki/index.md` | p-wiki compile / `pwiki index` |
| Tasks | `docs/tasks/tasks.yml` (or Jira) | p-tasks |
| Project rules | `.claude/rules/p-flow.md`, `.claude/rules/p-wiki.md`, `.claude/rules/p-tasks.md` | each plugin's init |
| Security deny-list | `.claude/settings.json` `permissions.deny` | p-flow (merge-on-init) |

No more `specs/` at repo root. One layout, owned by `superpowers`, augmented by sibling files from `p-flow` templates.

---

## Risks, known issues, and mitigations

### Confirmed Claude Code bugs that affect this design

| Bug | Reference | Impact | Mitigation |
|---|---|---|---|
| SessionStart hooks not discovered in local-marketplace dev installs | <https://github.com/anthropics/claude-code/issues/11509> | Hook silently doesn't fire during development | Test SessionStart with both git-registered marketplace AND local install before each release. Document in plugin READMEs. |
| Superpowers SessionStart double-injection | <https://github.com/obra/superpowers/issues/648> | Our SessionStart context may be doubled | Each plugin's injection includes a unique HTML comment marker. Lint script (post-v1) can detect duplicates. |
| Deny rules bypassed by Bash | <https://adversa.ai/blog/claude-code-security-bypass-deny-rules-disabled/> | `permissions.deny` doesn't protect against `bash -c "cat .env"` | Explicit caveat in `p-flow:rules`. Sandbox use recommended for adversarial setups. |

### Design-level risks

- **Rule compliance ~95%, not 100%.** Claude can ignore or forget a rule. The SessionStart stale-warning is the safety net for missed compiles; for missed task lifecycle updates there is no automatic recovery in v1. Acceptable trade-off given the alternative (hidden LLM operations on every write).
- **Compile cost.** Each spec compile is one LLM call (5–10 min per llm-wiki-compiler observations). Bootstrap of an existing repo with 30 docs could mean 30 calls. Documented; user controls when bootstrap runs.
- **Coexistence with superpowers' own hooks.** Superpowers v4.3.0 uses PostToolUse+Stop hooks for gate-enforcement. Our SessionStart hooks fire on a different event, so direct conflict is unlikely — but the additionalContext from superpowers and from p-wiki/p-tasks combine. We can't dedupe across plugins; we can only mark our injections so problems are diagnosable.
- **Plugin install order matters for p-flow:init's auto-detection.** If a user installs p-flow before p-wiki, the rule file won't include the wiki glue. Mitigation: `p-flow:init` is idempotent-aware — re-running it (after manually deleting the marker) re-detects peers and re-writes the rule. Document the re-init procedure.
- **No way to redirect Read.** `PreToolUse` hooks cannot modify tool input, only block/allow/defer. So we cannot transparently "intercept" `superpowers` reading a spec and serve a concept page instead. We rely on SessionStart context injection to put navigation in front of the agent, and on rules to teach drill-down.

---

## Not doing (in v1)

Explicit non-goals, recorded so the next contributor doesn't relitigate them:

- **Auto-compile via PostToolUse hook** in default config. Available as opt-in `.pwiki.json` flag (future enhancement, not v1). Default is rule-driven compile + stale-warning recovery.
- **Auto-create task via PostToolUse hook** in default config. Same rationale.
- **Auto-update task status (in_progress / done) via Stop hook or transcript parsing.** Too fragile in v1. Status updates are rule-driven.
- **Compiling source code into wiki pages.** Out of scope. `/p-wiki:bootstrap` excludes code files. `compile` continues to accept any path technically but documentation steers users toward doc-like sources only.
- **Codebase navigation map (Aider-style repo-map).** Out of scope for this spec. Worth a separate brainstorm; tracked as follow-up work.
- **Embedding / RAG-based code search.** Out of scope; infrastructure too heavy for the marketplace.
- **PreCompact hook with `type: "prompt"`** for checkpoint-on-compaction. Skipped on YAGNI: Opus 4.7 with 1M context makes compaction rare. Re-evaluate if real users hit it.
- **Forking or modifying superpowers.** All integration lives in our plugins. Superpowers cache stays untouched.
- **Building p-wiki as a thin wrapper over llm-wiki-compiler.** Considered; decided against. p-wiki stays independent for control and roadmap autonomy.
- **Native `TaskCreate` as a backend for p-tasks.** Native tasks are per-user, ephemeral, not git-trackable. p-tasks keeps its YAML/Jira backend. Native `TaskCreate` and p-tasks coexist as different layers (ephemeral working memory vs persistent feature tracker).

---

## Decomposition into follow-up specs

This document is overarching. Implementation is decomposed into four follow-up specs, each producing working software on its own:

1. **`p-tasks superpowers integration`** — schema fields, `from-plan` and `link-plan` skills, SessionStart hook, updated CLAUDE.md and rule templates.
2. **`p-wiki autocompile guardrails and bootstrap`** — SessionStart hook with stale-warning, `bootstrap` skill, `.last-compile` marker, `.pwiki.json` `mode` field, opt-in autocompile flag (stub for future).
3. **`p-flow orchestration rules`** — rewritten `rules-p-flow.template.md` with cross-plugin glue, layout decision (drop `specs/`), `p-flow:init` peer-detection.
4. **`marketplace integration testing`** — end-to-end test scenarios: install all three plugins + superpowers in a fixture repo, run brainstorming → check hooks fired → run writing-plans → check task created → reload session → check stale-warning appears.

Order: implement 1, 2, 3 in parallel where possible (they touch different plugins), then 4 against the combined state. Each gets its own `superpowers:writing-plans` plan.

---

## Open questions for implementation

These were not resolved during brainstorming and require empirical answers during implementation:

1. **Exact format and frequency of superpowers' own PostToolUse and Stop hook outputs.** Need to read its current `hooks/hooks.json` and trace what fires when. Will our additionalContext play nicely with theirs? Cannot answer without running real sessions.
2. **Does `find -newer` work cross-platform** (POSIX-ok, Windows depends on Git Bash / WSL availability)? May need a Node fallback for the stale-check.
3. **Performance of `p-tasks summary` invocation on every SessionStart.** Probably negligible (<200ms), but should be measured on a 500-task repo before shipping.
4. **`hookSpecificOutput.additionalContext` size limits.** Documentation doesn't enumerate; need to test what happens with a 10kb injection.
5. **Discovery probe in `p-flow:init` for peer plugins.** Checking for `docs/wiki/` / `docs/tasks/` is reliable post-init but not pre-init. Alternative: probe for plugin cache markers. Decide during implementation.

---

## References

Prior art consulted and what we kept / dropped:

- `victor-software-house/task-tracker-plugin` (low maturity, public refactoring plan) — pattern of `type: "prompt"` hooks noted; PostToolUse on Edit|Write **explicitly rejected** per their own findings.
- `ussumant/llm-wiki-compiler` (mature, 265 stars) — copied `mode` config field idea; copied SessionStart-only architecture; copied stale-detection via `find -newer`; copied query mechanism (LLM over INDEX, no embeddings).
- `obra/superpowers` v4.3.0 — confirmed write paths (`docs/superpowers/specs/`, `docs/superpowers/plans/`); confirmed it uses PostToolUse+Stop internally — implies caution on hook coexistence.
- `eyaltoledano/claude-task-master` — validates yaml/json local task storage; Jira mirror is genuinely under-served (kept as p-tasks differentiator).
- `bmad-code-org/BMAD-METHOD`, `buildermethods/agent-os`, Cline Memory Bank — validate the instruction-set-as-plugin and discovery-index-inject patterns.
- Claude Code official docs:
  - Hooks: <https://docs.claude.com/en/docs/claude-code/hooks>
  - Plugins reference: <https://docs.claude.com/en/docs/claude-code/plugins-reference>
  - Settings: <https://docs.claude.com/en/docs/claude-code/settings>

---

## Acceptance criteria for this design

This design is considered accepted when:

1. The decomposition into four follow-up specs is approved.
2. The layout decisions table is approved (especially: drop `specs/`, sibling-file pattern under `docs/superpowers/specs/<slug>/`).
3. The "not doing" list is approved (no auto-compile, no code-in-wiki, no PreCompact).
4. The risks are acknowledged (~95% rule compliance, hook-coexistence caveats, known Claude Code bugs).

Approval initiates `superpowers:writing-plans` for the first follow-up spec (`p-tasks superpowers integration`).
