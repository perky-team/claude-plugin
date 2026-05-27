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

*(filled at Task 2)*

---

## Dimension C — Native CC tool integration

*(filled at Task 3)*

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
