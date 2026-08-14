# Task 5 Report: score.mjs — run the hidden suite, read TAP

## What Was Created

1. **Test file**: `plugins/p-tasks/tools/__tests__/measure-score.test.ts`
   - 6 tests total covering `parseTap`, `scoreSnapshot`, and `expectedTests` functions
   - Tests verify TAP parsing, snapshot scoring, and reference test list extraction

2. **Implementation**: `plugins/p-tasks/scripts/measure-tracker/score.mjs`
   - `parseTap(text)` → extracts TAP test results from output
   - `expectedTests({ referenceDir, acceptanceFile })` → runs suite against reference to get expected test names
   - `scoreSnapshot({ snapshotDir, acceptanceFile, expected })` → runs suite in snapshot and scores each test
   - All three functions match the brief exactly

## TDD Evidence

### Step 1-2: Failing Tests (Before Implementation)

```
$ npx vitest run plugins/p-tasks/tools/__tests__/measure-score.test.ts
Error: Cannot find module '../../scripts/measure-tracker/score.mjs'
...
Test Files  1 failed (1)
      Tests  no tests
```

### Step 3-4: Passing Tests (After Implementation)

**Windows run:**
```
$ npx vitest run plugins/p-tasks/tools/__tests__/measure-score.test.ts
✓ plugins/p-tasks/tools/__tests__/measure-score.test.ts (6 tests) 1879ms
  ✓ expectedTests > takes the list from the reference implementation, where all are green 1353ms

Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:33:53
   Duration  3.30s
```

**WSL run (Node 24):**
```
$ export PATH=$HOME/.local/node24/bin:$PATH && cd ~/tracker-ab && npx vitest run plugins/p-tasks/tools/__tests__/measure-score.test.ts
✓ plugins/p-tasks/tools/__tests__/measure-score.test.ts (6 tests) 618ms
  ✓ expectedTests > takes the list from the reference implementation, where all are green 430ms

Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:34:08
   Duration  1.17s
```

## Platform Results

- **Windows**: 6 passed, no warnings, no stray output ✓
- **WSL (Node 24)**: 6 passed, no warnings, no stray output ✓ (this is the authoritative run)

## expectedTests Reference Count

Against `polygon-reference`: **37 test names** returned, all matching pattern `R\d+ ` (requirement ID format)

## Self-Review

1. **Hidden suite file removal**: Verified ✓
   - `runSuite()` has `finally { rmSync(target, { force: true }) }` that always removes the copied acceptance.test.js, even if spawnSync throws

2. **Failed test as false, not missing**: Verified ✓
   - `scoreSnapshot()` returns `Object.fromEntries(expected.map((name) => [name, said[name] === true]))`
   - Every name in `expected` gets an entry; if not in `said`, it defaults to `false` (undefined === true is false)
   - Test in `scoreSnapshot` suite confirms: when import error kills runner, both tests return `false`

3. **No extra additions**: Verified ✓
   - Code is exact transcription from brief, no modifications
   - Comments preserved from brief for clarity on design decisions
   - No extra functions, error handling, or logging

## Commit

Created: `a54c8b9 feat(p-tasks): score a snapshot against the hidden suite`

Files:
- `plugins/p-tasks/scripts/measure-tracker/score.mjs` (55 lines)
- `plugins/p-tasks/tools/__tests__/measure-score.test.ts` (86 lines)

## Fix: Per-Test Timeout to Preserve Results on Hang

A defect was found in the design: when one test hangs and the spawn timeout kills the runner, Node collapses the entire file into one `not ok 1 - acceptance.test.js` line, throwing away all the `ok` lines that had already been reported. This would score a snapshot 0 of 37 even though 20 tests had already passed.

**Changes made:**
1. Added per-test timeout constants (`TEST_TIMEOUT_MS = 3_000` and `RUN_TIMEOUT_MS = 180_000`)
2. Passed per-test timeout to Node via `--test-timeout=${TEST_TIMEOUT_MS}` flag
3. Extracted the scoring decision into a testable `resultFrom` function
4. Updated timeout defaults to use `RUN_TIMEOUT_MS`
5. Added 3 new tests for `resultFrom` to verify the "did not score" vs "all red" distinction

**Windows run (after fix):**
```
✓ plugins/p-tasks/tools/__tests__/measure-score.test.ts (9 tests) 1263ms
  ✓ expectedTests > takes the list from the reference implementation, where all are green 888ms

Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  12:47:07
   Duration  1.86s
```

**WSL run (Node 24, after fix):**
```
✓ plugins/p-tasks/tools/__tests__/measure-score.test.ts (9 tests) 1016ms
  ✓ expectedTests > takes the list from the reference implementation, where all are green 761ms

Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  12:47:36
   Duration  2.01s
```

**expectedTests count check:** Still returns **37 test names** from `polygon-reference` (time: 898ms)

**Fix commit:**
- `7640f87 fix(p-tasks): keep per-test results when one test hangs`

Files modified:
- `plugins/p-tasks/scripts/measure-tracker/score.mjs` (added per-test timeout, extracted `resultFrom`)
- `plugins/p-tasks/tools/__tests__/measure-score.test.ts` (added 3 new `resultFrom` tests)

## Fix 2: Simplify the No-Score Rule

The initial `resultFrom` tests had both halves of the decision condition agree in every test case, making them unable to catch a logic error in the condition itself. The rule was simplified to one atomic concept: no test line reported means no score.

**Old condition:** `!output.includes('TAP version') && !/^(not )?ok \d+ - /m.test(output)` (AND)
**New condition:** `!/^(not )?ok \d+ - /m.test(output)` (single check)

**Cases checked for disagreement:**
1. Empty output: old → null, new → null (agree)
2. Spawn error (no TAP, no test): old → null, new → null (agree)
3. TAP header with test line: old → result, new → result (agree)
4. TAP header, broken import (produces `not ok` line): old → result, new → result (agree)
5. TAP header, no tests (empty suite): old → all red, new → null (DISAGREE)

Only case 5 diverges. Old rule: `!hasHeader && !hasLines` → `!true && !false` → `false` = all red (scores agent 0 of 37 for a harness fault). New rule: `!hasLines` → `!false` → `true` = null (correct, nothing proven about the code). The new rule correctly rejects this case as unscorable, while the old rule would blame the agent.

**New test added:** specifically tests TAP header without test lines to pin the rule that the old tests missed.

**Windows run (with simplified rule):**
```
✓ plugins/p-tasks/tools/__tests__/measure-score.test.ts (10 tests) 1470ms
  ✓ expectedTests > takes the list from the reference implementation, where all are green 1032ms

Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  12:52:57
   Duration  2.09s
```

**WSL run (Node 24, with simplified rule):**
```
✓ plugins/p-tasks/tools/__tests__/measure-score.test.ts (10 tests) 739ms
  ✓ expectedTests > takes the list from the reference implementation, where all are green 479ms

Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  12:53:13
   Duration  1.76s
```

**Fix 2 commit:**
- `5c2185f fix(p-tasks): no test line, no score`

Files modified:
- `plugins/p-tasks/scripts/measure-tracker/score.mjs` (simplified `resultFrom` guard to single condition)
- `plugins/p-tasks/tools/__tests__/measure-score.test.ts` (added test for TAP header without test lines)
