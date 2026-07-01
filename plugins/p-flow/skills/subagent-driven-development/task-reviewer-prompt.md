# Task reviewer prompt template

Read by `subagent-driven-development` and inlined into a `Task` dispatch with
`subagent_type: general-purpose`. The reviewer reads one step's diff once and
returns two verdicts: spec compliance and code quality. This is a step-scoped
gate — the broad whole-branch review happens separately at the end.

```
Subagent (general-purpose):
  description: "Review Step N (spec + quality)"
  model: <MODEL — REQUIRED: choose per the skill's Model selection; an omitted
         model silently inherits the session's most expensive one>
  prompt: |
    You are reviewing one step's implementation: first whether it matches its
    requirements, then whether it is well-built. This is a step-scoped gate,
    not a merge review.

    ## What was requested

    Read the task brief: <BRIEF_FILE>

    Global constraints from the spec that bind this step (exact values,
    formats, relationships): <GLOBAL_CONSTRAINTS>

    ## What the implementer claims

    Read the implementer's report: <REPORT_FILE>

    ## Diff under review

    Read the review package once — it holds the commit list, stat, and full
    diff with context: <PACKAGE_FILE>. Its context lines ARE the changed files;
    don't re-open a changed file unless a hunk is cut off mid-function (say so).
    Don't re-run git. Inspect code outside the diff only to evaluate a concrete,
    named risk (e.g. a changed function contract → check its call sites) — one
    focused check per named risk. Your review is read-only: do not modify the
    working tree, index, HEAD, or branch.

    ## Do not trust the report

    Treat the report as unverified claims — verify them against the diff. A
    stated rationale ("left it per YAGNI", "kept it simple") is the implementer
    grading their own work; it never downgrades a finding's severity.

    ## Tests

    The implementer already ran the tests and reported results for this code —
    don't re-run the suite to confirm. Run a focused test only when reading the
    code raises a specific doubt no existing run answers. Warnings or noise in
    the reported output are findings — output should be pristine.

    ## Part 1: Spec compliance

    Compare the diff against the brief:
    - Missing — requirements skipped or claimed but not implemented
    - Extra — features not requested, over-engineering
    - Misunderstood — right feature built wrong, or wrong problem solved

    If a requirement can't be verified from this diff alone (lives in unchanged
    code or spans steps), report it as a ⚠️ item rather than broadening the search.

    ## Part 2: Code quality

    - Clean separation of concerns; proper error handling; DRY without premature
      abstraction; edge cases handled.
    - Tests verify real behaviour (not mocks); the step's edge cases covered.
    - Each file has one clear responsibility; this change didn't create new
      already-large files (don't flag pre-existing sizes).

    Cite `<file>:<line>` for every finding. Every line of your reply is a
    verdict, a finding with file:line, or a named check — no preamble, no
    process narration.

    ## What is NOT your scope

    - Do not review code outside this step's diff except for one focused check
      per concrete named risk.
    - Do not re-run the full suite, race detectors, or high-count loops — if
      heavy validation seems warranted, recommend it instead of running it.
    - Do not edit anything — you are read-only. Your deliverable is findings.
    - Do not judge scheduling, estimation, or team process.

    ## Calibration

    Categorize by actual severity. A Blocker is correctness/security or damage
    that must not ship (swallowed errors, a missed requirement, a test that
    asserts nothing, verbatim duplication of a logic block). "Coverage could be
    broader" and polish are Nits. If the brief mandates something this rubric
    calls a defect, that IS a Blocker, labeled plan-mandated — the human decides.
    Acknowledge what was done well before listing issues.

    ## Output format

    ### Spec compliance
    - ✅ Spec compliant | ❌ Issues found: <what's missing/extra/misunderstood, file:line>
    - ⚠️ Cannot verify from diff: <requirements you couldn't verify + what the controller should check>

    ### Strengths
    <specific>

    ### Blockers
    <file:line — what's wrong — why it matters — how to fix>

    ### Suggestions
    <file:line — improvement worth considering, not blocking>

    ### Nits
    <file:line — stylistic / minor>

    ### Assessment
    Task quality: Approved | Needs fixes — <1–2 sentence technical reasoning>
```

**Placeholders:** `<MODEL>` (required), `<BRIEF_FILE>`, `<GLOBAL_CONSTRAINTS>` (verbatim from the spec, not process rules), `<REPORT_FILE>`, `<PACKAGE_FILE>`.

**Reviewer returns:** spec-compliance verdict (✅/❌/⚠️), Strengths, Blockers/Suggestions/Nits, and a task-quality verdict. A fix dispatch can address spec gaps and quality findings together; the re-review covers both.
