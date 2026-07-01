# Prior-art consultation (used by task-brainstorming; optionally writing-plan)

When a task hinges on an approach, and the problem is one others have already solved, it is
worth checking **how it's commonly done** before committing the design — then recording a
cited recommendation the user can accept or reject.

Unlike the p-tasks / p-wiki / p-graph bridges, this one is **judgment-gated, not
marker-gated**: there is no "prior-art plugin" to detect. It is opt-in, **never automatic,
never a precondition** for producing the spec. Consulting internal knowledge (the p-wiki
bridge) comes first; this is the *external* look.

## Gate — when to consult

Offer a prior-art look **only** when at least one holds:

- the task involves choosing a library, framework, protocol, or algorithm that has
  established alternatives;
- it's a domain with well-known best practices / pitfalls (auth, crypto, rate-limiting, schema
  migrations, pagination, accessibility, i18n, …);
- the user explicitly asks "how do others do this" / "what's the recommended way";
- the approach is **novel to this codebase** and a wrong call is expensive to reverse.

Otherwise say nothing and continue the requirements dialog. A routine CRUD / config / typo /
straightforward-bugfix task does **not** need a web look — don't offer one.

## How to consult — prefer delegation, keep it bounded

1. **Library / framework / API specifics** → prefer **`context7`** when it is available
   (`resolve-library-id` → `query-docs`): version-accurate docs beat a web guess. If context7
   isn't installed, fall back to the web look below.
2. **Deep, multi-source, needs-verification questions** → suggest the user run
   **`/deep-research <question>`** rather than doing it inline — it fans out, verifies, and
   returns a cited report. Don't reproduce that heavyweight loop here.
3. **A quick "how is this commonly done / common pitfalls" scan** → `WebSearch` for 1–3
   focused queries, then `WebFetch` the 1–2 most authoritative results. Bounded — not an
   open-ended crawl, not a survey of every result.

Keep every query tied to **this** design decision. Don't research tangents; don't turn the
brainstorm into a literature review.

## What to do with findings

- Fold the options into the dialog as **concrete choices for the user** (this vs. that, with
  the trade-off), not a lecture.
- Record the chosen approach, the alternatives considered, and **why**, with **source URLs**,
  in `specs/<slug>/adr.md` (Alternatives considered / Decision). If no ADR is warranted, add a
  one-line `Prior art: <finding> (<source URL>)` note under the relevant spec section.
- The recommendation is the **user's to accept** — surface it, don't impose it. Citations make
  it traceable and let the user verify.

## Discipline

- **Never a precondition.** If the look is skipped, or a source is unreachable, produce the
  spec anyway.
- **No silent scope creep.** A shiny option that expands the task is a **decomposition flag**
  (brainstorming §3), not a silent addition to this task.
- **No coupling.** `context7` and `/deep-research` are used **when present**, never required.
  No `plugin.json#dependencies`; the built-in `WebSearch` / `WebFetch` are the only hard
  capability this bridge relies on.
- **Publishing note.** A web search sends the query to an external service. Fine for a design
  question; never paste secrets, credentials, or proprietary detail into a query.
