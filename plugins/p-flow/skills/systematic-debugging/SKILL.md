---
name: systematic-debugging
description: Use when verification fails, a test goes red, or behaviour is unexpected — before proposing any fix. Enforces reproduce → hypothesise → test the hypothesis → narrow → fix at root cause → re-verify, one hypothesis at a time. Stops guess-and-check debugging.
allowed-tools: Bash Read Edit Glob Grep
---

# systematic-debugging

A failure is a question, not a prompt to start changing things. Reproduce it, form one falsifiable hypothesis, test that hypothesis, narrow, then fix the root cause — not the symptom.

**Announce at start:** *"I'm using the `systematic-debugging` skill to find the root cause before changing anything — reproduce, hypothesise, test, narrow, fix, re-verify."*

## When to use

- `verification-before-completion` reported a failure (the primary entry point — `executing-plan` routes here on a red step).
- A test is red, an assertion trips, or observed behaviour differs from expected.
- A bug report you're about to fix — find the cause before touching code.

**Don't use when:** the cause is already proven (you have the failing line and know why). Then just fix it (via `test-driven-development` if it's a behaviour change).

## Inputs

- The failure itself — error message, failing test name, or the unexpected behaviour, quoted concretely.
- The code path involved.

## Procedure

### 1. Reproduce reliably

- Get a **consistent** failing case. Run the failing test/command and **quote the exact failure** (message + location).
- If it's intermittent — pin down what makes it flip (input, ordering, timing, environment). An unreliable repro means you can't tell whether a fix worked.

### 2. Form ONE hypothesis

- State a single, specific, **falsifiable** claim about the cause: *"`parseDate` returns `null` for ISO strings without a timezone, so the comparison on line 42 throws."*
- Not "something's wrong with dates." A hypothesis you can't test is not a hypothesis.

### 3. Test the hypothesis cheaply

- Add a probe (log, assertion, focused test) or inspect state at the suspected point. Confirm or refute the claim. **Quote the result.**
- **Refuted** → discard it, form the next hypothesis (back to step 2). Do NOT keep a speculative change that didn't help — revert it.
- **Confirmed** → continue.

### 4. Narrow to the root cause

- Binary-search the failure: bisect the input, comment out / isolate code regions, or `git bisect` across recent commits to find the introducing change.
- Keep going until you can point at the **specific** line/condition responsible — not just the general area.

### 5. Fix at the root cause

- Fix the cause, not the symptom. (Catching the exception that the bad input produced is a symptom fix; rejecting/normalising the bad input is a root fix.)
- If the fix is a behaviour change, go through `test-driven-development` — write the regression test that fails for this bug FIRST (RED), then the fix (GREEN).

### 6. Re-verify

- Invoke `verification-before-completion` via the Skill tool. The bug is fixed only when the new regression test passes AND the full suite is green. Quote it.

## Hard rules

- **Reproduce before hypothesising.** No repro → no reliable signal that a fix worked.
- **One hypothesis at a time.** Changing several things at once means you won't know which mattered.
- **Change one thing per test.** Revert speculative edits that didn't confirm a hypothesis before trying the next.
- **Root cause, not symptom.** Don't suppress the error; explain and remove its cause.
- **Never claim "fixed" without re-running.** Evidence before assertions — same rule as `verification-before-completion`.

## Red flags — STOP

- "Let me just try changing this and see if it helps" → no; state a hypothesis first.
- "I'll add a `sleep` / retry to make the flaky test pass" → that hides the cause, doesn't fix it.
- "I'll wrap it in try/except to stop the error" → symptom fix; find why the error happens.
- "I changed five things and now it works" → you don't know what fixed it; revert and isolate.

## What this skill does NOT do

- Does not write the regression test itself — that goes through `test-driven-development`.
- Does not declare completion — `verification-before-completion` does that.
- Does not push or open an MR — that's `/p-flow:task-end`.
