# Plan — {{SLUG}}

> TDD plan — each Step follows RED → GREEN → REFACTOR. The skill `test-driven-development` enforces this discipline for code Steps; the `verification-before-completion` skill enforces the final check before any "done" claim.

## Steps

1. [ ] <action — what behaviour to add or change>
   - **Test first** (RED): <which test file + which assertion proves the behaviour. Run; expect FAIL with: `<expected failure message>`>
   - **Implement** (GREEN): <minimal change in which files to make the test pass>
   - **Verify** (REFACTOR-safe): <which command to run; expect PASS + full suite still green>
   - **Acceptance**: <observable result; e.g. AC-1 + AC-2 satisfied>
   - **Files**: <test file + implementation file(s)>

2. [ ] <action>
   - **Test first** (RED): <which test + expected failure>
   - **Implement** (GREEN): <minimal change>
   - **Verify** (REFACTOR-safe): <command + expected pass>
   - **Acceptance**: <observable result>
   - **Files**: <test + impl>

## Open questions

- <questions that block or could change the plan>

## Risks

- <known risks, with mitigation if any>
