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

*(filled at Task 6 synthesis)*

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

*(filled at Task 4)*

---

## Dimension E — Behavioral output parity

*(filled at Task 5)*

---

## Open questions

*(consolidated at Task 6 from `unclear` verdicts across dimensions)*

---

## Recommended follow-up plans

*(synthesized at Task 6)*
