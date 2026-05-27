# p-flow — superpowers parity audit

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Systematically compare `p-flow` against the upstream `superpowers` plugin (currently `v5.1.0` in local cache at `C:\Users\suhar\.claude\plugins\cache\claude-plugins-official\superpowers\5.1.0`). Produce a single gap-report document that catalogs every divergence, classifies each as **intentional / gap / unclear**, and proposes follow-up plans for any gap worth closing.

**Type:** Research / analysis. **No code changes.** No skill / agent / template edits. No tests. The deliverable is a single Markdown document.

**Why now:** The original `p-flow` design spec (`plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md`) declared "leaner alternative to superpowers" but did not perform a systematic parity check. As a result, gaps surfaced ad-hoc — most recently: superpowers' agent-as-template-inside-skill pattern vs. p-flow's registered-subagent pattern, and the absence of a session-start hook. The user needs a methodology to find the *rest* of the gaps in one pass instead of ten.

**Out of scope:**

- **Remediation.** The plan produces a gap-report and *proposes* follow-up plans; it does not change any agent / skill / hook. Each accepted gap becomes its own future plan.
- **Subjective quality judgments.** "Their prose is better" is not a gap. The audit measures *capability and shape*, not style.
- **Project-specific superpowers content.** Their `CLAUDE.md` contributor policies (94% PR rejection rate, etc.) are governance, not capability. Skip.
- **superpowers' interactive scripts** (`brainstorming/scripts/server.cjs`, etc.) — capability noted but full UX adoption is its own plan.

**Spec reference:** none new — this audit references the existing `2026-05-26-task-flow-design.md` and produces a complementary spec doc (the gap-report).

**Deliverable file:** `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md`. Created in Task 6 by synthesizing the per-dimension findings from Tasks 1–5.

---

## Audit dimensions

The audit covers five orthogonal dimensions. Each task produces one section of the final spec doc.

| # | Dimension | What it measures |
|---|---|---|
| A | **Skill inventory** | Which of superpowers' 14 skills have an equivalent in p-flow, which are intentionally absent (with rationale), which are gaps |
| B | **Architectural patterns** | Agent dispatch model, hooks, top-level files, `_shared/` vs co-located auxiliary files, multi-host hints, release infrastructure |
| C | **Native tool integration** | Per-skill, which CC tools are invoked (`Bash`, `Read`, `Write`, `Skill`, `Task`/`Agent`, `AskUserQuestion`, `TaskCreate`, etc.) — flag divergences |
| D | **Naming + frontmatter conventions** | Plurals, `allowed-tools` syntax, `model:` declarations, optional frontmatter fields, file layout under each skill dir |
| E | **Behavioral output parity** | For skills with direct analogs (verification, requesting-code-review, brainstorming, writing-plans, finishing-a-development-branch) — compare output structure, step counts, verbatim message conventions |

Each Task below executes one dimension. Tasks are independent and can be reordered; sequential ordering chosen for readability of the final synthesis.

---

## Task 1: Skill inventory matrix (Dimension A)

**Files:** none modified; produces a section of the final spec doc (written in Task 6). This task writes a scratchpad in this plan's "Findings" sub-section at the end (or in conversation).

- [ ] **Step 1: Enumerate every superpowers skill**

Source: `ls C:/Users/suhar/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/` — 14 skills as of `v5.1.0`. For each, read frontmatter `name:` and `description:` (already collected in the audit prep — re-confirm by re-running `for d in $SP/skills/*/; do awk '/^description:/...' $d/SKILL.md; done`).

- [ ] **Step 2: Map each superpowers skill to a p-flow status**

For each, classify with one of:

| Status | Meaning |
|---|---|
| `match` | p-flow has a directly equivalent skill (same purpose; name may differ) |
| `partial` | p-flow has overlapping coverage but the skill is split / merged / shaped differently |
| `intentional-skip` | superpowers has it; p-flow design spec explicitly opted out (cite the spec section/line) |
| `deferred` | p-flow design spec defers to Wave 2+ (cite the Wave list) |
| `gap` | p-flow lacks it AND no design rationale for the absence |
| `meta` | superpowers' skill is a meta-skill (`using-superpowers`, `subagent-driven-development`, `writing-skills`) — needs separate verdict on whether p-flow needs its own |

- [ ] **Step 3: For each `gap`, propose verdict**

Each gap gets one of: **adopt** (build the missing skill), **adapt** (build a p-flow-shaped variant), **skip** (with rationale why), **unclear** (needs user input).

- [ ] **Step 4: Save to scratchpad**

Hold the matrix in conversation context (or in the plan's findings section appended at the bottom). Final synthesis in Task 6.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md
git commit -m "docs(p-flow): audit superpowers parity — skill inventory (Task 1)"
```

Acceptance: matrix exists, every one of the 14 superpowers skills classified, every `gap` has a verdict (even `unclear`).

---

## Task 2: Architectural patterns audit (Dimension B)

**Files:** none modified; findings to scratchpad.

- [ ] **Step 1: Inventory superpowers' architectural surface**

For each of these areas, document the superpowers convention and the p-flow convention:

| Area | Question |
|---|---|
| Agent dispatch | Where do subagent prompts live? Registered subagents (`agents/<name>.md`) vs co-located templates (`skills/<name>/<agent>.md`) vs inline-in-SKILL.md |
| Hooks | Which CC hooks are wired? `SessionStart`, `UserPromptSubmit`, `PreCompact`, etc. |
| Top-level multi-host files | `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` at plugin root — present? what's in them? |
| Plugin manifest extras | `homepage`, `repository`, `license`, `keywords` fields filled? |
| `_shared/` pattern | Is there a `_shared/templates/` dir? Or are templates co-located inside each skill that uses them? |
| Auxiliary files in skills | What can live inside a skill dir besides `SKILL.md`? (scripts, reference docs, prompt templates, example files) |
| References subdirectory | `skills/<name>/references/` for platform-specific tool mappings (Codex, Copilot, Gemini)? |
| Release / changelog | `RELEASE-NOTES.md` at plugin root? Git tags only? Per-plugin or per-marketplace? |
| Contributor guidance | `CONTRIBUTING.md`? `CODE_OF_CONDUCT.md`? At repo or plugin level? |
| Plugin-level tests / scripts | `package.json`, `tests/`, `scripts/` at plugin level? (separate from marketplace-level tests) |

- [ ] **Step 2: For each row, mark divergence**

Three buckets:

- **divergence-by-design** — p-flow chose differently with rationale (e.g. `_shared/` because templates are referenced by multiple skills + auto-tested for dead-templates)
- **gap** — p-flow lacks something useful with no rationale (e.g. no session-start hook → no discovery affordance)
- **unclear** — divergence exists but rationale isn't documented anywhere; needs user input

- [ ] **Step 3: For each gap, propose action**

Same verdict shape as Task 1: adopt / adapt / skip / unclear.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md
git commit -m "docs(p-flow): audit superpowers parity — architectural patterns (Task 2)"
```

Acceptance: every architectural area has both columns filled (superpowers convention + p-flow convention) + verdict.

---

## Task 3: Native CC tool integration audit (Dimension C)

**Files:** none modified.

- [ ] **Step 1: For each p-flow skill, list invoked tools**

For each of `init`, `task-brainstorming`, `writing-plan`, `verification-before-completion`, `requesting-code-review`, `requesting-task-review`, `task-start`, `task-end`:

1. Grep the SKILL.md body (NOT frontmatter `allowed-tools`) for invocations: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Skill tool`, `Agent` / `Task tool`, `AskUserQuestion`, `TaskCreate`/`TaskUpdate`/`TaskList`, `WebFetch`, `WebSearch`, `ExitPlanMode`.
2. Cross-check against `allowed-tools` frontmatter — any tool used in the body MUST be in `allowed-tools`; any tool in `allowed-tools` SHOULD be referenced in the body. Note any drift.

- [ ] **Step 2: For each superpowers analog skill, list invoked tools**

Same grep for the analogous skill identified in Task 1.

- [ ] **Step 3: Build pair-by-pair diff**

| skill (p-flow / superpowers) | tools p-flow uses | tools superpowers uses | divergence | verdict |
|---|---|---|---|---|

Verdicts: same/superset/subset/incompatible.

- [ ] **Step 4: Look for systemic patterns**

Examples of patterns worth flagging:

- Does superpowers use `AskUserQuestion` anywhere? (preliminary scan said zero)
- Does superpowers use `TaskCreate` anywhere? (preliminary scan said zero)
- Does p-flow use `Skill` tool to chain skills? Does superpowers?
- How does each handle interactive prompts when there are more than 4 options?

- [ ] **Step 5: Commit**

```bash
git add plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md
git commit -m "docs(p-flow): audit superpowers parity — native tool integration (Task 3)"
```

Acceptance: every p-flow skill has a row; every p-flow skill with a superpowers analog has both columns filled.

---

## Task 4: Naming + frontmatter conventions audit (Dimension D)

**Files:** none modified.

- [ ] **Step 1: Frontmatter field census**

For all 14 superpowers skills + all 8 p-flow skills, list which frontmatter fields appear:

| Field | superpowers usage | p-flow usage | divergence |
|---|---|---|---|
| `name` | always | always | none |
| `description` | always | always | check max/min char length convention |
| `allowed-tools` | varies | always | check format (space- vs comma-separated) |
| `argument-hint` | ? | sometimes | check |
| `model` | rare? | absent | check |
| ... | | | |

- [ ] **Step 2: Naming conventions**

- Plurals: `writing-plans` (sp) vs `writing-plan` (pf); `executing-plans` vs (none yet); etc.
- Slash-command syntax: p-flow uses `/p-flow:<skill>` (plugin-prefixed); does superpowers expose slash commands at all? (Quick check: are any superpowers skills also `/superpowers:<name>` commands?)
- File names inside skill dirs: superpowers uses lowercase-kebab (`spec-document-reviewer-prompt.md`, `code-reviewer.md`); p-flow's agents use the same convention but in `agents/` not co-located.

- [ ] **Step 3: Body conventions**

- Use of `<EXTREMELY-IMPORTANT>` / `<SUBAGENT-STOP>` XML-style emphasis tags — superpowers uses them; p-flow does not.
- Section heading conventions: `## Overview`, `## Procedure`, `## Output format`, etc. — are there standard sets?
- "Announce at start" pattern: superpowers' `finishing-a-development-branch` says: *"Announce at start: 'I'm using the X skill to ...'"* — p-flow doesn't have this convention.
- Use of Graphviz diagrams (`digraph ...`) in skill bodies for flow visualization — superpowers uses them extensively; p-flow doesn't.

- [ ] **Step 4: Verdicts**

For each convention divergence: **adopt** (worth aligning with superpowers), **keep-as-is** (p-flow's choice is fine), **document** (a convention exists in p-flow that should be written down somewhere — e.g. `CONTRIBUTING.md` for the plugin).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md
git commit -m "docs(p-flow): audit superpowers parity — naming and frontmatter conventions (Task 4)"
```

Acceptance: census table complete; every divergence has a verdict.

---

## Task 5: Behavioral output parity audit (Dimension E)

**Files:** none modified.

- [ ] **Step 1: Identify analog pairs**

Pairs to compare (from Task 1's matrix):

| superpowers | p-flow |
|---|---|
| `verification-before-completion` | `verification-before-completion` |
| `requesting-code-review` | `requesting-code-review` |
| `brainstorming` | `task-brainstorming` |
| `writing-plans` | `writing-plan` |
| `finishing-a-development-branch` | `task-end` |

- [ ] **Step 2: For each pair, diff the output structure**

Read both SKILL.md files end-to-end. Compare:

- Number and shape of Procedure steps (e.g. superpowers' verification = ? steps; p-flow's = 7 steps)
- Output format examples (e.g. superpowers' requesting-code-review output vs p-flow's `### Blockers / ### Suggestions / ### Nits`)
- Verbatim message templates ("You're on a protected branch...", "This repo has no test suite I can detect...")
- Severity model (blocker/suggestion/nit vs critical/important/minor vs other)
- Termination / hand-off conventions

- [ ] **Step 3: Flag drift opportunities**

For each pair, decide:

- **interop-aligned** — outputs are mutually intelligible; a downstream consumer (human or skill) can read either without surprises
- **drift-cosmetic** — outputs differ in wording but not in shape (acceptable)
- **drift-structural** — outputs differ in shape (severity model, sections, sequence) — gap

- [ ] **Step 4: For each structural drift, decide action**

Same shape: adopt / adapt / skip / unclear.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md
git commit -m "docs(p-flow): audit superpowers parity — behavioral output (Task 5)"
```

Acceptance: every analog pair has a structural verdict.

---

## Task 6: Synthesize the gap-report spec doc

**Files:**
- Create: `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md`

- [ ] **Step 1: Compose the spec**

Document structure:

```markdown
# Spec — p-flow ↔ superpowers parity gap report

## Overview
- Date, audit scope, references to source plan, audit methodology summary.

## Summary table
- One line per gap. Columns: dimension / area / current state / superpowers state / verdict (adopt|adapt|skip|unclear) / priority (high|medium|low) / suggested follow-up plan name.

## Dimension A — Skill inventory
- Matrix from Task 1 verbatim.

## Dimension B — Architectural patterns
- Matrix from Task 2.

## Dimension C — Native tool integration
- Matrix from Task 3.

## Dimension D — Naming + frontmatter conventions
- From Task 4.

## Dimension E — Behavioral output parity
- From Task 5.

## Open questions
- Every `unclear` verdict aggregated, with the user-facing question explicit.

## Recommended follow-up plans
- 0..N short proposals, each with: slug, scope (which gaps it closes), rough effort estimate, dependencies.
```

- [ ] **Step 2: Pull from each task's scratchpad / commit history**

Walk back through commits made in Tasks 1–5 — each had a scratchpad section. Consolidate without re-doing work.

- [ ] **Step 3: Apply priority ranking**

For each gap:

- **high** — affects portability, correctness, or user-visible safety (e.g. agent dispatch pattern, missing skills used in daily flow)
- **medium** — improves UX or maintainer ergonomics but plugin still works without it (e.g. session-start hook, multi-host files)
- **low** — cosmetic / convention alignment (e.g. plurals, XML emphasis tags)

- [ ] **Step 4: Validate the doc**

Self-checks:
- Every `gap` from Tasks 1–5 appears in the summary table.
- Every `unclear` appears in `## Open questions`.
- Every proposed follow-up plan has a unique slug + non-empty scope.
- No placeholder text (`TBD`, `TODO`, `...`).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md
git commit -m "docs(p-flow): superpowers parity gap report"
```

Acceptance: doc exists, all sections populated, validates against self-checks.

---

## Task 7: Present to user + propose next steps

**Files:** none modified.

- [ ] **Step 1: Surface the gap-report summary**

Print to the user (in conversation, not a file):

- Total number of gaps by priority (e.g. "5 high, 8 medium, 11 low")
- Top 3 high-priority gaps with one-line description each
- Number of `unclear` items requiring user input
- List of recommended follow-up plans with their slugs + effort estimates

- [ ] **Step 2: Ask for next direction**

Pose with `AskUserQuestion`:

1. **Address all high-priority gaps as a single Wave 1.2 remediation plan?** (recommended if ≤ 5 high gaps)
2. **Cherry-pick** — user picks which gaps to address now vs defer
3. **Defer all** — file the spec, address gaps when next touching nearby code
4. **Need to clarify `unclear` items first** — answer the open questions, then re-rank

- [ ] **Step 3: Based on user direction**

If (1) → spawn a new plan `plugins/p-flow/docs/plans/2026-05-XX-superpowers-parity-remediation.md`.
If (2) → spawn smaller plans per-gap.
If (3) → done.
If (4) → take answers, update spec doc, return to step 1.

- [ ] **Step 4: No commit, no tag**

Step 3's plans (if any) are spawned separately.

---

## What this plan deliberately does NOT do

- **No agent / skill / hook / template / test changes.** Audit only.
- **No remediation work.** Output is a spec; remediation is a future plan.
- **No comparison against external plugins** other than `superpowers`. Other Claude-Code plugins (e.g. shadcn, octo) might have useful patterns, but they're not the reference.
- **No re-litigation of design choices** that the existing spec (`2026-05-26-task-flow-design.md`) already justified. The audit may flag them as `intentional` if rationale exists in that doc.
- **No release.** No `plugin.json` bump, no tag — research commits ride into the next behavioral release.

## Self-review checklist (for the engineer)

- [ ] All 14 superpowers skills classified (Task 1).
- [ ] All architectural areas in Task 2's table filled.
- [ ] All p-flow skills audited for native tool usage (Task 3); every analog pair diffed.
- [ ] Frontmatter census complete (Task 4).
- [ ] All 5 analog pairs in Task 5 have structural verdicts.
- [ ] Gap-report exists at `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md` and passes self-validation in Task 6 Step 4.
- [ ] User has seen the summary and chosen the next direction (Task 7).
- [ ] 6 commits land cleanly on `main` (one per audit task + synthesis).
- [ ] No code (agents/skills/tests) modified.
