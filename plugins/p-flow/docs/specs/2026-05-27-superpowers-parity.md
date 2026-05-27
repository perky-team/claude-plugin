# Spec — p-flow ↔ superpowers parity gap report

| Field | Value |
|---|---|
| Date | 2026-05-27 |
| Audit scope | `p-flow` plugin against `superpowers v5.1.0` (local cache: `C:\Users\suhar\.claude\plugins\cache\claude-plugins-official\superpowers\5.1.0`) |
| Methodology | Per-plan `2026-05-27-superpowers-parity-audit.md` — 5 dimensions (skill inventory, architectural patterns, native tool integration, naming/conventions, behavioral output). Read-only; no code changes. |
| Source plan | `plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md` |
| Design reference | `plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md` (the original p-flow design spec — cited where it justifies a divergence) |

---

## Summary

Total gaps surfaced: **24** across 5 dimensions. Roll-up by priority:

| Priority | Count | Items |
|---|---|---|
| **High** | 6 | B1 (agent dispatch pattern), A-5 (`receiving-code-review`), A-9 (`test-driven-development`), A-11 (`using-p-flow` discovery skill), E4 (writing-plan not TDD-aligned), E5 (task-end no options menu) |
| **Medium** | 8 | A-2 (`dispatching-parallel-agents`), A-4 (broaden `finishing-a-development-branch` analog), A-10 (extract `using-git-worktrees`), A-14 (`writing-skills`), B2 (session-start hook), C-2 (`allowed-tools` over-declaration), C-3 (verification dispatches agent — investigate), D-7 (Graphviz adoption) |
| **Low** | 7 | A-13 (plural rename), B7 (`RELEASE-NOTES.md`), B10 (plugin-level `CLAUDE.md`), B12 (`assets/`), C-4 (Agent vs Task tool name), D-6 (`<EXTREMELY-IMPORTANT>` on discovery skill), D-8 ("Announce at start") |
| **Acceptable / divergence-by-design** | 11 | A-3 + A-8 (Wave 2 deferrals), A-7 (subagent-driven-development — use sp's), B3–B6, B8, B9, B11 (multi-host / `_shared` / refs / scripts / docs), D-1 + D-2 (frontmatter conventions, slash-command exposure), D-4 (skill dir layouts) |

**Headline findings:**

1. **superpowers v5.1.0 explicitly migrated AWAY from registered subagents** to inline-template Task dispatch. p-flow chose the opposite (Dim B1). High-impact architectural divergence — and the smoke-test from earlier showed our agents are unreachable without plugin install. **This is the single most consequential gap.**

2. **p-flow is post-hoc verification, not TDD** (Dim A-9 + E4). superpowers' `writing-plans` template bakes RED-GREEN-REFACTOR into every step; p-flow's template is action-result without test-first discipline. Major capability difference, originally flagged as a non-goal in the design spec.

3. **No discovery skill / session-start hook** (Dim A-11 + B2). p-flow is invisible until the user mentions a `/p-flow:*` command or matching keyword. superpowers loads `using-superpowers` via session-start hook for active discoverability.

4. **Two complementary review skills missing** (Dim A-5 + the existing `requesting-code-review`). superpowers ships `receiving-code-review` to teach Claude to PROCESS feedback rigorously, not just request it. p-flow only handles the request side.

**Encouraging findings:**

- The architectural choices p-flow makes intentionally (strict `allowed-tools`, centralized `_shared/templates/`, registered agents) are *defensible* — they trade portability for safety + maintainability. The audit doesn't say p-flow is wrong, only that several gaps are unintentional.
- Both plugins independently ignore `AskUserQuestion`, `TaskCreate`, `TaskUpdate`. Earlier conversation framed this as a p-flow oversight — actually the conventional pattern. **Corrected.**

---

---

## Dimension A — Skill inventory

`superpowers v5.1.0` ships **14 skills**. p-flow ships **8 skills** (`init` + 7 from task-flow Wave 1). Matrix:

| # | superpowers skill | p-flow equivalent | Status | Verdict |
|---|---|---|---|---|
| 1 | `brainstorming` | `task-brainstorming` | **match** (different name, same role) | keep — task-brainstorming is the dev-flavored fork |
| 2 | `dispatching-parallel-agents` | — | **gap** | **adapt** (low priority) — p-flow doesn't have a documented parallel-dispatch pattern; design spec says nothing about it. Useful when a `requesting-*-review` skill could dispatch both code-reviewer + task-reviewer in parallel (currently sequential, two skills) |
| 3 | `executing-plans` | — | **deferred** (Wave 2 per design spec §6 "Future Considerations") | keep deferred — Wave 2 commitment |
| 4 | `finishing-a-development-branch` | `task-end` | **partial** — task-end is push + MR-recommend only; superpowers' version presents options including merge/cleanup/PR | **adapt** — consider broadening task-end to a structured option menu (not just push+recommend). Medium priority |
| 5 | `receiving-code-review` | — | **gap** — counterpart to `requesting-code-review`; helps Claude *process* review feedback rigorously rather than implementing blindly | **adopt** — high value; closes the loop on the review cycle. High priority |
| 6 | `requesting-code-review` | `requesting-code-review` | **match** | keep |
| 7 | `subagent-driven-development` | — | **meta** — this is the meta-skill *used by* Claude to execute plans (we used it today from superpowers' copy) | **skip** — depending on superpowers for this is fine; no need to fork |
| 8 | `systematic-debugging` | — | **deferred** (Wave 2 per design spec §6) | keep deferred |
| 9 | `test-driven-development` | — (only verification-after, not test-first) | **gap** — TDD is RED-GREEN-REFACTOR (write test first, watch fail, write code, watch pass); verification-before-completion is the *check-before-claiming-done* part only | **adopt** — high value; p-flow's `writing-plan` skill could refuse plan steps that don't follow TDD when applicable. High priority |
| 10 | `using-git-worktrees` | embedded in `task-start --worktree` | **partial** — superpowers has it as a standalone reusable skill; p-flow buries it inside one flag of one skill | **adapt** — extract a standalone `using-git-worktrees` so other future skills can reuse worktree-creation logic. Medium priority |
| 11 | `using-superpowers` | — | **meta** — discovery skill loaded by superpowers' session-start hook; tells Claude how to *find* skills | **adopt** — p-flow needs its own discovery skill (or share with superpowers if both installed). Without it, p-flow skills get invoked only when user types `/p-flow:*` or by happenstance keyword-matching. High priority (couples with Dimension B — session-start hook) |
| 12 | `verification-before-completion` | `verification-before-completion` | **match** | keep |
| 13 | `writing-plans` | `writing-plan` | **match** (cosmetic plural diff) | keep; consider renaming for parity in a low-priority pass |
| 14 | `writing-skills` | — | **gap** — meta-skill for creating/editing skills with TDD discipline | **adopt** — would standardize how p-flow itself grows. Used today by anyone contributing to p-flow plugin. Medium priority (more for contributors than end-users) |

### p-flow-only skills (no superpowers analog)

| p-flow skill | Justification |
|---|---|
| `init` | p-flow-specific — bootstraps `.claude/settings.json` + rules + templates in a target repo. Superpowers has no equivalent because superpowers IS the rules, installed via plugin. |
| `task-start` | Workflow-glue: branch + spec-dir + brainstorm hand-off as a single entry point. Superpowers leaves these as separate skills (using-git-worktrees + brainstorming, invoked manually) |
| `task-end` | Workflow-glue: push + MR-recommend. Partial overlap with `finishing-a-development-branch` (see #4) but with a stricter scope (just-push). |

### Gap roll-up by verdict

- **adopt** (high priority): `receiving-code-review`, `test-driven-development`, `using-superpowers` (with session-start hook)
- **adopt** (medium priority): `writing-skills`
- **adapt** (medium priority): `using-git-worktrees` (extract from task-start), `finishing-a-development-branch` (broaden task-end)
- **adapt** (low priority): `dispatching-parallel-agents`
- **skip**: `subagent-driven-development` (use superpowers'), `executing-plans` + `systematic-debugging` (Wave 2)
- **cosmetic**: `writing-plans` rename to plural

---

## Dimension B — Architectural patterns

| # | Area | superpowers convention | p-flow convention | Verdict |
|---|---|---|---|---|
| B1 | **Agent dispatch** | Inline template files inside skill dir (`skills/<name>/<agent>.md`). SKILL.md instructs *"Use Task tool with `general-purpose` type, fill template at `<file>.md`"*. **Migrated AWAY from registered subagents in v5.1.0** — see RELEASE-NOTES: *"every other reviewer/implementer subagent in the repo dispatches `general-purpose` with a prompt template alongside its skill"*. | Registered subagents at plugin-level `agents/<name>.md`. SKILL.md dispatches via `Agent` tool with `subagent_type: <name>`. | **gap — high priority** (superpowers explicitly chose the opposite pattern). Smoke-test confirmed our agents are unreachable without plugin install. Proposed: migrate to inline-template pattern; see follow-up plan `migrate-agents-to-templates`. |
| B2 | **Session-start hook** | `hooks/hooks.json` wires `SessionStart` → `hooks/session-start` script → reads `using-superpowers/SKILL.md` and emits it as a `<system-reminder>` so the skill is always invoked. | None. Skills are passive — triggered by user phrasing or explicit `/p-flow:*`. | **gap — medium priority**. Without a session-start nudge, users have to know p-flow exists. Couples with B-3 (need `using-p-flow` discovery skill first). |
| B3 | **Multi-host plugin manifests** | Ships 5 platform definitions: `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.opencode/`, plus `gemini-extension.json` at root. Each has its own `plugin.json` with same name/version, host-specific UI fields (`displayName`, `category`, `capabilities`). | Only `.claude-plugin/`. | **divergence-by-design (acceptable for now)** — perky.team plugins are Claude Code-only. Document the limitation in plugin README. Re-evaluate if multi-platform support becomes a goal. |
| B4 | **Multi-host context files** | `AGENTS.md` (pointer file with content `CLAUDE.md`), `GEMINI.md` (uses `@./skills/using-superpowers/SKILL.md` include syntax), `gemini-extension.json` with `contextFileName: GEMINI.md`. CLAUDE.md is rich contributor-guide content. | None at plugin root (CLAUDE.md exists at marketplace root for repo-wide rules). | **divergence-by-design (acceptable)** — same reasoning as B3. The marketplace-level CLAUDE.md covers Claude-Code-only audience. |
| B5 | **`_shared/templates/` vs co-located** | No `_shared/` dir. Per-skill auxiliary files inside each skill (`skills/<name>/code-reviewer.md`, `skills/<name>/scripts/server.cjs`, `skills/<name>/references/codex-tools.md`, etc.). | Centralized `skills/_shared/templates/` for reusable templates referenced by multiple skills; per-template "dead template" test ensures no orphans. | **divergence-by-design (acceptable)** — p-flow's pattern works because templates ARE reused (init writes 4 of them into the target repo, brainstorming reads them at runtime). superpowers' templates are typically single-skill prompt fragments — co-location makes sense. Don't migrate. |
| B6 | **`references/` subdirectory for platform mappings** | `skills/using-superpowers/references/` ships `codex-tools.md`, `copilot-tools.md`, `gemini-tools.md` — per-platform tool name maps so a skill written with CC tool names works on other agents. | None — p-flow uses CC tool names directly without translation layer. | **divergence-by-design (acceptable for now)** — paired with B3/B4: CC-only scope. Future-proofing only if multi-platform becomes a goal. |
| B7 | **Release notes** | `RELEASE-NOTES.md` at plugin root (66 KB, full changelog per version). Synced via `.version-bump.json`. | Git tags + commit messages only. | **gap — low priority**. RELEASE-NOTES.md would help users see what changed without `git log`. Less critical for personal-plugin scope but useful as it grows. Proposed: add a minimal `RELEASE-NOTES.md` next major release. |
| B8 | **Version bump automation** | `.version-bump.json` declares all version-stamped files (4 plugin.json variants + gemini-extension.json + marketplace.json) so one bump script touches all. `scripts/bump-version.sh` runs it. | Manual edit of `plugin.json` + commit. CLAUDE.md describes the procedure. | **divergence-by-design (acceptable)** — single plugin manifest = no bump fan-out. If we add multi-host (B3), reconsider. |
| B9 | **Plugin-level `tests/` and `scripts/`** | Both present at plugin root. `package.json` declares plugin-level npm scripts. | Tests live at marketplace root (`tests/` shared across all 4 plugins). No per-plugin scripts. | **divergence-by-design (acceptable)** — marketplace-level tests amortize across plugins; we don't have plugin-specific test infrastructure needs. |
| B10 | **Contributor guidance files** | `CLAUDE.md` (7.5 KB — for AI agents contributing), `CODE_OF_CONDUCT.md`, `.github/` (PR templates etc.). | None at plugin root. Repo-level `CLAUDE.md` at marketplace root has release procedures. | **gap — low priority**. As p-flow grows, dedicated `plugins/p-flow/CLAUDE.md` could capture plugin-specific contributor rules (writing-skills convention, agent dispatch pattern decision). |
| B11 | **`docs/` at plugin root** | Top-level `docs/` for high-level architectural docs (separate from per-skill content). | `docs/` exists with `plans/` + `specs/` for design history. Same idea, different structure. | **acceptable** — both serve the same purpose. Format diverges; OK. |
| B12 | **`assets/` at plugin root** | Yes — likely for images/icons referenced in marketplace UI. | None. | **gap — low priority**. Once a marketplace UI shows plugin icons, this matters. |

### Architectural roll-up

- **gap — high**: B1 (agent dispatch pattern)
- **gap — medium**: B2 (session-start hook — couples with `using-p-flow` discovery skill from Dimension A)
- **gap — low**: B7, B10, B12 (release notes, contributor doc, assets)
- **divergence-by-design (acceptable)**: B3, B4, B5, B6, B8, B9, B11

### Key insight

The two architectural gaps with real impact (B1 + B2) **share a common root cause**: p-flow was designed as a self-contained plugin without thinking about how a user *discovers* it (B2) or how *other Claude Code sessions* can invoke its agents (B1). Both fixes pull p-flow closer to superpowers' "passive scaffolding" model where the plugin is always-available, always-discoverable, and skills/agents are content-not-config.

---

## Dimension C — Native CC tool integration

### Per-skill tool census (p-flow side)

| skill | declared `allowed-tools` | body mentions | drift |
|---|---|---|---|
| `init` | Bash(narrow) + Read + Write | Bash, Read, Write | OK |
| `task-brainstorming` | Read + Write + Edit + Glob + Bash(narrow) | Read, Write, Skill tool | Edit declared but never used; Skill tool used but not declared (only used as protocol verb "via the Skill tool") |
| `writing-plan` | Read + Write + Edit + Glob | Read, Write | Edit + Glob unused |
| `verification-before-completion` | Bash + Read + Glob + Grep + Write + Edit | Bash, Write | Read/Glob/Grep/Edit declared but body doesn't use |
| `requesting-code-review` | Bash(narrow) + Read + Write + Edit + Glob + Agent | Agent, "AskUserQuestion" (as anti-pattern note) | OK — extra tools (Read/Edit/Glob) cover plan.md edits |
| `requesting-task-review` | same as above | Agent | OK |
| `task-start` | Bash(narrow) + Read + Write | "Skill tool" | OK (Skill is protocol verb) |
| `task-end` | Bash(narrow) + Read + Glob | (none — body uses verbs like "Run `git push`") | OK — natural-language verbs, all Bash usage covered |

### Per-skill tool census (superpowers side)

**Critical convention difference**: **superpowers skills do NOT declare `allowed-tools` at all** in any of the 11 skills examined. All rely on default tool availability.

| skill | body mentions |
|---|---|
| `brainstorming` | Write |
| `writing-plans` | Write |
| `verification-before-completion` | Read, Write, Agent (dispatches verifier subagent — different shape!) |
| `requesting-code-review` | Read, **Task tool** (= older name for Agent) |
| `finishing-a-development-branch` | (none — pure narrative) |
| `test-driven-development` | Write |
| `using-superpowers` | Read, Write, Skill tool |
| `using-git-worktrees` | Read, Glob |
| `dispatching-parallel-agents` | Read, Agent |
| `receiving-code-review` | Grep |
| `writing-skills` | Read, Write, Edit, Agent |

### Pair-by-pair diff

| pair | p-flow tools | superpowers tools | divergence | verdict |
|---|---|---|---|---|
| brainstorming | strict allowlist + Read/Write/Edit/Glob/Bash(git rev-parse) | (no allowlist) + Write | shape | acceptable — p-flow tighter |
| writing-plan(s) | Read/Write/Edit/Glob | Write | over-declaration | low-priority cleanup — remove unused tools |
| verification-before-completion | Bash/Read/Glob/Grep/Write/Edit | Read/Write/**Agent** | **structural** — sp dispatches a verifier subagent; p-flow runs tests directly | unclear — does superpowers dispatch a verifier for safety isolation? If so, worth understanding before next prompt change. |
| requesting-code-review | Agent + Bash + Read/Write/Edit | Task tool + Read | tool-name divergence (`Agent` vs `Task tool` — same tool, two names) | **gap — low priority** — align to superpowers naming since "Task tool" is the older established name (or stay with "Agent" — Claude Code accepts both) |
| finishing-a-development-branch vs task-end | strict allowlist | none in body | same shape (both rely on declared) | acceptable |

### Systemic patterns

| Pattern | superpowers | p-flow |
|---|---|---|
| Declares `allowed-tools` | never | always (every skill) |
| Uses `AskUserQuestion` | never | never (only as anti-pattern note in requesting-code-review) |
| Uses `TaskCreate` / `TaskUpdate` | never | never |
| Uses `ExitPlanMode` / `EnterPlanMode` | never (grep) | never |
| Uses `WebFetch` / `WebSearch` | never (in this scan) | never |
| Uses `Skill tool` (cross-skill dispatch) | yes (using-superpowers) | yes (task-start → task-brainstorming, task-brainstorming → writing-plan) |
| Tool dispatch terminology | `Task tool` (consistently, post v5.1.0 cleanup) | `Agent` (newer name) |

### Dimension C roll-up

- **gap — medium**: `allowed-tools` over-declaration in 3 p-flow skills (task-brainstorming, writing-plan, verification-before-completion) — declared tools not used in body. Tightening would catch mismatched intent. Low complexity fix.
- **gap — low (unclear)**: superpowers' verification-before-completion dispatches an agent — why? Worth one-time read before deciding to follow.
- **gap — low**: tool-name terminology (`Agent` vs `Task tool`) — pure cosmetic, both work.
- **observation**: both plugins independently ignore `AskUserQuestion` and `TaskCreate`. The "missed integration" claim from earlier conversation was **wrong** — staying out of them is the conventional pattern, not an oversight.

---

## Dimension D — Naming + frontmatter conventions

### Frontmatter field census

| Field | superpowers (n=14) | p-flow (n=8) | Verdict |
|---|---|---|---|
| `name` | 14/14 | 8/8 | parity |
| `description` | 14/14 | 8/8 | parity |
| `allowed-tools` | **0/14** | 8/8 | structural divergence (see C-3 / observation) |
| `argument-hint` | **0/14** | 3/8 (init, task-start, task-end) | structural divergence (p-flow uses some skills as slash commands; superpowers doesn't) |
| `model:` (in SKILL) | 0/14 | 0/8 | parity (only agents declare model) |

**Observation**: superpowers' frontmatter is dead-minimal (just `name` + `description`). p-flow's is structured (always `allowed-tools` for sandbox safety, sometimes `argument-hint` for slash-command exposure). Both choices are valid.

### Slash-command exposure

- **superpowers**: never declares `argument-hint`. Per the v5.1.0 RELEASE-NOTES: *"Legacy slash commands removed — `/brainstorm`, `/execute-plan`, and `/write-plan` are gone. They were deprecated stubs that did nothing but tell the user to invoke the corresponding skill."* All invocation goes through `Skill` tool now.
- **p-flow**: 3 skills (`init`, `task-start`, `task-end`) are first-class slash commands. The other 5 are model-invoked.
- **Verdict**: **divergence-by-design (acceptable)**. p-flow's flow-entry-points need to be user-driven (you start a task explicitly, not by mentioning a keyword). The other 5 can stay model-invoked.

### Body section heading conventions

| superpowers top headings (frequency) | p-flow top headings (frequency) |
|---|---|
| `## Overview` (11) | `## Procedure` (5) |
| `## When to Use` (5) | `## What this skill does NOT do` (5) |
| `## Red Flags` (5) | `## Preconditions` (2) |
| `## Common Mistakes` (5) | `## Inputs` (2) |
| `## The Process` (4) | `## Out of scope` (2) |
| `## Quick Reference` (4) | `## When to run` (1) |
| `## The Iron Law` (3) | per-step headings (init only) |

**Different DNA**: superpowers writes *pedagogically* (Overview → When to Use → The Process → Red Flags → Common Mistakes). p-flow writes *specification-style* (Preconditions → Procedure → Out of scope → What this skill does NOT do). 

Functional analogs exist:
- `## When to Use` ≈ `## Preconditions`
- `## Red Flags` / `## Common Mistakes` ≈ `## What this skill does NOT do`
- `## The Process` ≈ `## Procedure`
- `## Overview` — no p-flow analog (p-flow skills jump straight into Procedure)

**Verdict**: **divergence-by-design (acceptable)**. Don't refactor. Worth documenting the convention in plugins/p-flow/CLAUDE.md (gap B10) so future p-flow skills stay consistent.

### Skill directory layouts

superpowers per-skill dirs are RICH with auxiliary files (per B5):
- `subagent-driven-development/` ships 4 prompt templates alongside SKILL.md (one per role)
- `systematic-debugging/` ships 6 reference docs + scripts + a `CREATION-LOG.md`
- `writing-skills/` ships `anthropic-best-practices.md` + examples/ + `graphviz-conventions.dot` + `persuasion-principles.md` + `render-graphs.js` + `testing-skills-with-subagents.md`
- `brainstorming/` ships an interactive HTTP server (`scripts/server.cjs`) for visual diagrams

p-flow dirs are minimal: each skill dir has only `SKILL.md`. Reusable content lives in `_shared/templates/`. Agents are at plugin-level `agents/`.

**Verdict**: **divergence-by-design (acceptable for now)** — p-flow's skills are simpler and don't need supporting docs/scripts. But if we adopt `writing-skills` (per Dimension A), we'll likely need a similar aux-file pattern. Re-evaluate then.

### XML emphasis tags

- `<EXTREMELY-IMPORTANT>` / `<SUBAGENT-STOP>` in superpowers: used in 1 file (`using-superpowers/SKILL.md`) — the highest-criticality skill (loaded on session start, must be obeyed).
- p-flow: 0 occurrences.

**Verdict**: **adopt-on-demand** — useful for top-of-funnel skills (e.g. if we add `using-p-flow` discovery skill per Dimension A). Not a generic style choice.

### Graphviz diagrams

- superpowers uses `digraph` blocks (DOT notation) in 6/14 skills to visualize flow logic.
- p-flow: 0 skills.

**Verdict**: **adopt — medium priority**. Graphviz is a powerful documentation pattern — flow logic in DOT is readable by humans AND parseable by tools. Worth adopting on next non-trivial skill body change. Could backport to `task-start` Phase A/B (which already has a 2-phase structure that diagrams well).

### "Announce at start" convention

- superpowers: 4 skills have `Announce at start: "I'm using the X skill to ..."` instruction.
- p-flow: 0 skills.

**Verdict**: **adopt — low priority**. Helps users understand what's happening in long-running skills. Easy to backport.

### Skill naming plurals

- superpowers: `writing-plans`, `executing-plans`, `dispatching-parallel-agents` (plural).
- p-flow: `writing-plan` (singular), no equivalent for others yet.

**Verdict**: **cosmetic — defer**. Renaming `writing-plan` → `writing-plans` is a breaking change for any skill or doc that references it. Not worth a release unless we batch with other breaking changes.

### Dimension D roll-up

- **adopt — medium**: Graphviz diagrams (D-7), use on next significant skill edit
- **adopt — low**: "Announce at start" (D-8), `<EXTREMELY-IMPORTANT>` on discovery skill (D-6)
- **document — low**: section-heading conventions (D-3) in `plugins/p-flow/CLAUDE.md`
- **cosmetic — defer**: plural rename (D-9)
- **divergence-by-design**: minimal frontmatter (D-1, D-2), slash-command exposure (D-2), skill dir layouts (D-4)

---

## Dimension E — Behavioral output parity

5 analog pairs structurally diffed. Line counts are sp ↔ pf.

### Pair E1: `verification-before-completion` (139 ↔ 85 lines)

| | superpowers | p-flow |
|---|---|---|
| Sections | 10 (Overview, Iron Law, Gate Function, Common Failures, Red Flags - STOP, Rationalization Prevention, Key Patterns, Why This Matters, When To Apply, Bottom Line) | 4 (When to run, Procedure, Hard rules, What this skill does NOT do) |
| Procedure shape | pedagogical (scolding rhetoric — "Don't fake success") | dry algorithmic (7 numbered steps, marker-write contract) |
| Filesystem side-effects | none documented | writes `.claude/.p-flow-state/<branch-safe>/last-verification`, appends to `.gitignore` |
| Agent dispatch | YES (body mentions Agent — but unclear what for) | NO (runs tests directly) |
| Verbatim messages | none | `"This repo has no test suite I can detect. I cannot verify by running tests."`, `"Verification failed."` |

**Verdict**: **drift-cosmetic** with one structural divergence (filesystem marker + .gitignore). pf's marker is the contract that `task-end` reads — a real coupling that sp doesn't have. **Interop**: a downstream skill reading pf's marker won't understand sp's. **Acceptable** — markers are p-flow-internal mechanics.

### Pair E2: `requesting-code-review` (103 ↔ 69 lines) + reviewer template

| | superpowers | p-flow |
|---|---|---|
| SKILL.md sections | 5 (When to Request, How to Request, Example, Integration with Workflows, Red Flags) | 3 (Preconditions, Procedure, What this skill does NOT do) |
| Dispatch | `Task tool` with `general-purpose` + inline template `code-reviewer.md` | `Agent` with `subagent_type: code-reviewer` (registered) |
| Reviewer output sections | `### Strengths / ### Issues / ### Recommendations / ### Assessment` (4, narrative) | `### Blockers / ### Suggestions / ### Nits` (3, severity-tiered) |
| Severity model | Strengths-Issues-Recommendations-Assessment (narrative) | Blockers-Suggestions-Nits (priority) | 
| Triage protocol | not in SKILL — relies on user to read narrative output | explicit 3-action triage (`fix`/`defer`/`reject`) with plan.md integration format |

**Verdict**: **drift-structural** — incompatible output formats. p-flow's severity model is more actionable + integrates with plan.md follow-ups; superpowers' narrative is more flexible but harder to triage. **Interop**: a human reading both reports would understand each but couldn't mechanically merge them.

**Question for follow-up**: should pf's `code-reviewer` agent (once converted to inline-template per B1) ALSO add the `Strengths` section to align? Probably not — Blockers/Suggestions/Nits is more useful.

### Pair E3: `brainstorming` ↔ `task-brainstorming` (164 ↔ 96 lines)

| | superpowers | p-flow |
|---|---|---|
| Sections | 7 (Anti-Pattern, Checklist, Process Flow, The Process, After the Design, Key Principles, Visual Companion) | 5 (Inputs, Templates source of truth, Procedure, Hard gates, Out of scope) |
| Template constraint | none — generates spec freely | strict — copies from `_shared/templates/specification.template.md` and fills `{{PLACEHOLDERS}}` |
| Visual companion | YES (ships HTTP server in `scripts/server.cjs` for visual diagramming) | NO |
| Hard gate before next skill | implicit ("After the Design") | explicit — `## Hard gates` block forbids invoking writing-plan before user approval |

**Verdict**: **drift-structural** — p-flow is template-constrained; superpowers is open-ended. Both produce a spec. **Interop**: a downstream skill (writing-plan) can read either, but pf's writing-plan EXPECTS the p-flow specification template structure. Cross-plugin spec reuse is brittle.

### Pair E4: `writing-plans` ↔ `writing-plan` (152 ↔ 61 lines)

| | superpowers | p-flow |
|---|---|---|
| Sections | 10 (Overview, Scope Check, File Structure, Bite-Sized Task Granularity, Plan Document Header, Task Structure, No Placeholders, Remember, Self-Review, Execution Handoff) | 8 (Inputs, Procedure, Plan template, Steps, Open questions, Risks, Numbering convention, Out of scope) |
| Plan template shape | TDD-driven: each Step has embedded failing test code + verify-fails command + verify-passes command (RED-GREEN-REFACTOR baked in) | Generic: each Step has `- **Acceptance**: <criterion>` + `- **Files**: <list>` (action-result format, no test-first) |
| Plan header | mandates explicit "REQUIRED SUB-SKILL: superpowers:subagent-driven-development" line | uses similar phrasing (we copy/paste this from superpowers convention in our own plans!) |
| Step count guidance | "bite-sized" — implies small | explicit 5–15 steps; flag larger for sub-task split |

**Verdict**: **drift-structural** — p-flow's plan format is NOT TDD-aligned. Steps don't enforce test-first. **High-impact**: this means p-flow's plans skip the discipline that makes superpowers' plans valuable. Couples directly with Dimension A gap: missing `test-driven-development` skill. **Follow-up**: when we adopt TDD skill, also revise writing-plan template to RED-GREEN-REFACTOR shape.

### Pair E5: `finishing-a-development-branch` ↔ `task-end` (251 ↔ 113 lines)

| | superpowers | p-flow |
|---|---|---|
| Sections | 7 (Overview, The Process, Summary, Test Plan, Quick Reference, Common Mistakes, Red Flags) | 4 (Pre-checks, Push, MR recommendation, What this skill does NOT do) |
| Process steps | 6: Verify Tests → **Detect Environment** → **Determine Base Branch** → **Present Options** → **Execute Choice** → Cleanup | 3 phases: Pre-checks (4) → Push (1) → MR recommendation (4) |
| Options presented to user | YES — explicit menu (merge / PR / cleanup) | NO — single path (push + recommend MR) |
| Environment detection | YES — detects local-only / fork / direct-push contexts | NO — assumes origin exists, asks for base only if main/master missing |

**Verdict**: **drift-structural — p-flow is a SUBSET**. Per Dimension A item #4, pf's task-end intentionally narrower than sp's finishing. But sp's "Detect Environment" + "Present Options" are real value-adds. **High-priority adapt candidate**: broaden task-end into an options menu (or keep current scope but document explicitly that p-flow chose narrow). **Question for user**: was the narrowing intentional, or just unaware?

### Dimension E roll-up

| Pair | Verdict | Severity | Action |
|---|---|---|---|
| E1 verification | drift-cosmetic + filesystem marker | low | acceptable |
| E2 requesting-code-review | drift-structural (severity model) | medium | keep p-flow's actionable model |
| E3 brainstorming | drift-structural (template-constrained) | low | acceptable — design intent |
| E4 writing-plan | drift-structural (no TDD) | **high** | couples with `test-driven-development` skill adoption (Dim A) |
| E5 task-end | drift-structural (no options menu) | **high** | couples with adapt verdict in Dim A #4 |

**Cross-dimension observations**:

- **TDD discipline missing** (E4 + Dim A #9) — both p-flow's writing-plan template AND the absence of `test-driven-development` skill mean p-flow is a *post-hoc verification* plugin, not a TDD plugin. The original design spec called this out as a non-goal — but it's a major capability gap vs superpowers.
- **Options-menu pattern missing** (E5 + Dim A #4) — task-end skips the menu that lets users choose merge path. p-flow optimizes for the most common case (push + MR); superpowers optimizes for flexibility. Both valid; pick deliberately.

---

## User decisions (2026-05-27)

The 4 open questions below were resolved in a follow-up review immediately after the audit synthesis:

| # | Question | Decision |
|---|---|---|
| Q1 | Agent dispatch — migrate or stay? | **Migrate inline** — convert `agents/*` into colocated templates inside `skills/requesting-*/`. Matches superpowers v5.1.0; smoke-test confirmed registered-subagent unreachability in dev sessions. |
| Q2 | TDD discipline — adopt or stay non-goal? | **Partial adopt** — add `test-driven-development` and `receiving-code-review` skills; `writing-plan` template OFFERS TDD-shape by default for code tasks but stays generic for docs/research plans. |
| Q3 | task-end menu — broaden or stay narrow? | **Stay narrow** — add a `## Design note` block to task-end documenting *why* we don't present a merge/PR/cleanup menu (git merge is a manual step; p-flow's role is push + recommend, not menu navigation). |
| Q4 | Verification subagent — investigate? | **Investigated; resolved** — sp doesn't dispatch a verifier; "Agent" mentions in its body are pedagogical anti-patterns, not dispatch actions. No remediation needed. |

---

## Open questions (original — historical)

The audit surfaced 4 questions; all are now resolved above. Kept for traceability:

1. **Agent dispatch — migrate or stay?** (Dim B1) p-flow's registered-subagent pattern works only when the plugin is installed. superpowers explicitly removed this pattern in v5.1.0. Migrating to inline-template Task dispatch is a breaking change to `agents/code-reviewer.md` + `agents/task-reviewer.md` + the two `requesting-*-review` skills. Worth it for portability, or keep registered for cleaner abstraction?

2. **TDD discipline — adopt or stay non-goal?** (Dim A-9 + E4) The original design spec listed TDD as a non-goal. Reaffirm — or revise the spec and adopt? Revising touches `writing-plan` template fundamentally + adds a new `test-driven-development` skill.

3. **task-end menu — broaden to options or stay narrow?** (Dim E5 + A-4) `finishing-a-development-branch` presents merge/PR/cleanup options; `task-end` does just push+MR-recommend. Was the narrowing intentional, or just unaware?

4. **Verification subagent — investigate?** (Dim C-3) ~~superpowers' `verification-before-completion` dispatches an Agent. We don't know what for.~~ **RESOLVED 2026-05-27 (post-investigation):** false positive in the original grep. sp does NOT dispatch a verifier subagent — the word "Agent" appears only in pedagogical examples warning *against* trusting agent reports without independent verification (`"Agent reports success → Check VCS diff → Verify changes → Report actual state"`). p-flow's direct test-running approach is fine; no remediation needed.

---



---

## Recommended follow-up plans

Proposed remediation grouped into 5 plans. Numbered by suggested execution order (dependencies first, breaking changes batched, cosmetics last).

### Plan 1 — `migrate-agents-to-inline-templates` (high priority)

**Scope:** B1 (sole driver). Convert `plugins/p-flow/agents/code-reviewer.md` and `task-reviewer.md` from registered subagents to inline templates colocated with their requesting skills (`skills/requesting-code-review/code-reviewer.md`, `skills/requesting-task-review/task-reviewer.md`). Update the two `requesting-*-review` SKILL.md files to dispatch via `Task tool` with `general-purpose` + template content instead of `Agent` with `subagent_type:`. Remove the empty `agents/` directory. Update `tests/agents.test.ts` to point at the new location OR replace with a "review-template structural test."

**Why first:** Unblocks portability (smoke-test showed agents unreachable without install). Breaks current contract — needs to land before any new skill adopts the old pattern.

**Effort:** ~2 hours. ~6 file changes. Test suite needs minor refactor.

### Plan 2 — `add-using-p-flow-discovery` (high priority, depends on hook decision)

**Scope:** A-11 + B2 + D-6. Create `skills/using-p-flow/SKILL.md` mirroring `superpowers:using-superpowers` (with `<EXTREMELY-IMPORTANT>` tag). Add `hooks/hooks.json` + `hooks/session-start` script to emit the skill as a `<system-reminder>` on session start. Document discovery contract in `plugins/p-flow/CLAUDE.md` (new file).

**Why second:** Hook + discovery skill come together — adoption of one without the other is half-done. Independent of Plan 1; can run in parallel.

**Effort:** ~3 hours. Mostly content authoring + one platform hook script.

### Plan 3 — `adopt-tdd-and-receiving-review` (high priority — pairs)

**Scope:** A-5 + A-9 + E4. Two new skills:
- `skills/test-driven-development/SKILL.md` — RED-GREEN-REFACTOR enforcement
- `skills/receiving-code-review/SKILL.md` — how to process review findings rigorously

Plus: revise `skills/writing-plan/SKILL.md`'s Plan template to enforce test-first step structure (each Step begins "Write failing test for X" + "Verify it fails" + "Implement" + "Verify it passes" — copy superpowers' shape).

**Why third:** Touches writing-plan template AND adds 2 skills. Breaking change to plan format (existing plans won't have TDD structure). Should land as a major behavior shift, separately from Plans 1+2.

**Effort:** ~4 hours. Mostly content authoring + template restructure + 1 test update.

**Open question dependency**: requires user direction on Question #2 above.

### Plan 4 — `broaden-task-end-options-menu` (high priority, isolated)

**Scope:** A-4 + E5. Add to `task-end` SKILL.md: environment detection step (local-only / fork / direct-push), options menu (push / open PR / merge-and-delete / push-and-cleanup / cancel), execute-choice handlers. Or document explicitly why p-flow chose to stay narrow (in a `## Design note` block at top of skill).

**Why fourth:** Independent of Plans 1–3. Can run any time.

**Effort:** ~2 hours. One skill file change.

**Open question dependency**: requires user direction on Question #3.

### Plan 5 — `cleanup-and-conventions` (medium + low priority, batch)

**Scope:** A-2 (`dispatching-parallel-agents`), A-10 (extract `using-git-worktrees`), A-14 (`writing-skills`), C-2 (allowed-tools over-declaration cleanup), C-4 (Agent → Task naming), D-7 (Graphviz adoption — backport to task-start at minimum), D-8 ("Announce at start" backport), B7 (RELEASE-NOTES.md), B10 (plugin-level CLAUDE.md).

**Why fifth:** Lots of small, independent items. Best as a single sweep release rather than per-item patches. Some require Plans 1–3 to land first (e.g. D-6 `<EXTREMELY-IMPORTANT>` on discovery skill needs Plan 2 first).

**Effort:** ~4 hours batched. ~12 file changes.

### Verdict on plan size

If user approves all 4 high-priority plans: ~11 hours of work spread across ~25 file changes + 1 major test refactor. Realistic as 2–3 release cycles (v4.6.x → v4.7.x → v4.8.x), not one big bang.

### What this audit explicitly recommends NOT doing

- **Don't migrate p-flow to multi-host** (B3, B4, B6) without a real need. perky.team is Claude-Code-only by intent.
- **Don't switch from `_shared/templates/` to colocated** (B5). p-flow's pattern is well-tested and has a real "dead template" check.
- **Don't rename `writing-plan` → `writing-plans`** (A-13, D-9) standalone — it's a breaking name change with no functional benefit. Batch with Plan 3 if at all.
- **Don't add `AskUserQuestion` / `TaskCreate` integrations.** Both plugins agree these aren't the right pattern. Stay aligned.

---

## Audit completion checklist

- [x] All 14 superpowers skills classified (Dim A — 24 verdicts incl. p-flow-only)
- [x] 12 architectural areas audited (Dim B)
- [x] 8 p-flow skills + 11 superpowers analogs audited for tool usage (Dim C)
- [x] Frontmatter census + body conventions audited (Dim D)
- [x] 5 analog pairs structurally diffed (Dim E)
- [x] Summary table aggregates all gaps by priority
- [x] Open questions section lists 4 user-decisions needed
- [x] 5 follow-up plans proposed with scope + effort + dependencies
- [x] Explicit "don't do this" list to prevent over-correction
