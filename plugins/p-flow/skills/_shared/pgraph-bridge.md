# p-graph bridge (used by writing-plan)

p-flow optionally consults the `p-graph` code knowledge graph while decomposing a plan —
**only** when p-graph is initialised in this same repo. One-way, opt-in courtesy: p-flow
knows about p-graph; p-graph knows nothing about p-flow.

## Why this bridge is *advisory*, not a dispatcher

Unlike the p-tasks and p-wiki bridges, p-graph exposes **no query skill** — its structural
queries (`impact`, `callers`, `callees`, `trace`, …) are CLI commands, not Skill-tool entry
points. And p-graph's own `/p-graph:init` installs a repo rule (`.claude/rules/p-graph.md`
plus a `CLAUDE.md` snippet) that **already** instructs the model to prefer `pgraph` over grep
for structural questions, with the full command table.

So this bridge does **not** call `pgraph` itself, does **not** duplicate its command table,
and does **not** reach into p-graph's `${CLAUDE_PLUGIN_ROOT}`. It only **nudges** `writing-plan`
to use the graph (which the model already knows how to drive, via the installed rule) at the
one moment it most improves a plan: decomposition + risk analysis. The exact commands are the
installed rule's responsibility — defer to it, so p-graph can evolve its CLI without dragging
p-flow along. (p-graph is pre-1.0; its surface may still change.)

## Gate — run this BEFORE any p-graph consultation

1. Resolve repo root (`git rev-parse --show-toplevel`).
2. `test -f "<root>/.pgraph/config.json"`.
   - **Absent** → p-graph is NOT active in this repo. Do nothing, say nothing, decompose the
     plan normally. (Do not mention p-graph.)
   - **Present** → continue below.

## Dispatch rules

- **Never** call p-graph's CLI by an explicit path — there is no path to p-graph's own
  `${CLAUDE_PLUGIN_ROOT}` from inside p-flow. Structural queries follow the repo's
  `.claude/rules/p-graph.md`, which the model is already under when p-graph is installed. The
  bridge points the model at the graph for impact analysis; the installed rule owns *which*
  commands run and *how* — so p-graph can change its CLI without dragging p-flow along.
- The **only** Skill-tool dispatch this bridge uses is `p-graph:sync`, to refresh a stale graph.

## Use — `writing-plan`, during decomposition (Procedure step 3)

When p-graph is active and the spec touches **existing** code, before finalising the step list:

1. **Check freshness first.** A stale graph that answers confidently wrong is worse than no
   graph. If code changed this session or the graph looks stale, refresh via the Skill tool —
   `p-graph:sync` — before trusting structural answers. (Per `.claude/rules/p-graph.md`.)
2. **Find the impact set.** Use the graph (per the installed rule) to find what the planned
   change touches — callers/callees of the symbols involved, and the blast radius of edits.
3. **Fold the result into the plan:**
   - Let the impact set inform **step granularity** — a change with many downstream callers
     usually needs more, smaller steps, not one big one.
   - Record notable downstream callers / affected modules under the plan's canonical `## Risks`
     section, so review and verification know what to watch.

This is a **best-effort aid**, never a precondition: if the graph is absent, stale and can't be
refreshed, or the task is greenfield (no existing code to analyse), decompose the plan normally.

## Confirmation rules

- Consulting the graph is a read; it needs no confirmation and produces no offer prompt — it
  silently improves the plan. (Contrast p-tasks/p-wiki, whose bridges *write* and therefore
  always offer first.)
- The one action that changes state — `p-graph:sync` (it rewrites the local index) — should be
  run when the graph is stale; mention it to the user when you do. It only touches the local,
  git-ignored `.pgraph/` index, so it needs no heavier confirmation.
