---
name: test-driven-development
description: Use when about to write code (production code path, not docs/scripts/research) — enforces RED-GREEN-REFACTOR — write a failing test first, watch it fail, write minimal code to pass, verify pass, refactor. Pairs with verification-before-completion (this skill is the "before code" gate; verification is the "before claiming done" gate).
allowed-tools: Bash Read Write Edit Glob Grep
---

# test-driven-development

Before writing any production code, write a test that fails for the right reason. Then write the minimum code to make it pass. Then refactor with the test as a safety net.

## When to use

- About to add a new function / endpoint / class / handler / pipeline stage that has observable behavior.
- About to fix a bug — the regression test comes first, before the fix.
- About to refactor — characterization tests come first, before the refactor.

**Don't use when:**

- The change is pure documentation, throwaway scripts, or exploratory research code where the goal is exploration rather than durability.
- Tests would be tautological (e.g. wrapping a single 3rd-party call with no logic).

## Procedure (RED-GREEN-REFACTOR)

### RED — Write a failing test

1. Identify the smallest observable behavior the change should produce.
2. Write a test that asserts that behavior.
3. Run the test. **Expected: FAIL** with a message that names the missing thing (e.g. `ReferenceError: foo is not defined`, `AssertionError: expected X got nothing`).
4. **Quote the failure** in your response. The failure is evidence the test actually tests something.

If the test passes immediately → the test is wrong. Fix the test, not the code.

### GREEN — Write minimal code to pass

5. Write the smallest amount of code that makes the test pass. Hardcoded values are OK at this stage; the test will force generalization in the next iteration.
6. Run the test. **Expected: PASS.** Quote the pass.
7. Run the full test suite. **Expected: all green** (no regressions).

If the test still fails → the code doesn't solve the problem stated by the test. Don't add scaffolding around the test to make it pass; reconsider the implementation.

### REFACTOR — Clean up under test cover

8. Improve naming, extract helpers, remove duplication. The test is your safety net.
9. Run the test after each refactor step. If it goes red, the last refactor was incorrect — revert it.

## Hard rules

- **Never claim "tests pass" without running them.** This skill cannot be satisfied by intuition.
- **Never write the implementation before the test.** Even by one line. The test must exist and fail FIRST.
- **Never weaken the test to make it pass.** If the test is too strict, the implementation is wrong, not the test.
- **One test → one behavior.** Don't bundle assertions for unrelated behaviors into a single test.

## Red flags — STOP

- "I'll write the test after; let me just sketch the code first" → no.
- "The test will be obvious once the code exists" → no; write it first.
- "This change is too small for TDD" → if it has observable behavior, it gets a test.
- "I added an assertion but the test always passes" → the assertion is tautological; tighten it.

## What this skill does NOT do

- Does not run the test suite on completion claims — that's `verification-before-completion`.
- Does not write integration tests for systems you don't own (mock at the boundary; don't reach into 3rd-party state).
- Does not enforce test framework choice (use whatever the repo already uses).
- Does not apply when no test framework exists in the repo — say so and ask whether to bootstrap one or skip TDD for this change.
