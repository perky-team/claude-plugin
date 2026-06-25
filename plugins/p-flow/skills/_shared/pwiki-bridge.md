# p-wiki bridge (shared by task-brainstorming + task-end)

p-flow optionally consults and feeds the `p-wiki` knowledge base — **only** when
p-wiki is initialised in this same repo. This is a one-way, opt-in courtesy: p-flow
knows about p-wiki; p-wiki knows nothing about p-flow.

The bridge is symmetric across the flow:

- **Read side** (`task-brainstorming`) — query accumulated knowledge *before* designing,
  so a new spec doesn't contradict prior decisions and reuses established patterns.
- **Write side** (`task-end`) — capture the task's durable decisions *after* it ships,
  so the next task can find them.

## Gate — run this BEFORE any p-wiki action

1. Resolve repo root (`git rev-parse --show-toplevel`).
2. `test -f "<root>/docs/wiki/.pwiki.json"`.
   - **Absent** → p-wiki is NOT active in this repo. Do nothing, say nothing, continue
     the host skill normally. (Do not offer, do not mention p-wiki.)
   - **Present** → continue below.

## Dispatch rules

- **Never** call p-wiki's CLI directly. There is no path to p-wiki's own
  `${CLAUDE_PLUGIN_ROOT}` from inside p-flow. Always go through the **Skill tool**,
  invoking the p-wiki skills — `p-wiki:query` (read) and `p-wiki:compile` (capture) — and
  let p-wiki resolve its own install.
- **Capture is `compile`, never `ingest`.** p-flow's artifacts (`specs/<slug>/*.md`) live
  *inside* the repo. `p-wiki:ingest` refuses in-repo paths by design and redirects to
  `compile`. Always invoke `p-wiki:compile <in-repo-path>`. `compile` is idempotent — keyed
  on the source file path, re-running updates the derived pages instead of duplicating them.
- **No join key, no stored id.** Unlike the p-tasks bridge, nothing links a p-flow task to
  a wiki page beyond the source file path that `compile` reads. p-flow files store no
  p-wiki id. `query` is stateless.
- **`query` is a mutation.** `p-wiki:query` writes `pages/queries/<date>-<slug>.md` (and may
  offer to promote it to a concept page). So even the "read" side is an offer, never silent.

## Read side — `task-brainstorming` (during the §2 dialog)

Once the task's subject area is clear but **before** finalising the spec direction, offer:

*"p-wiki is set up in this repo. Want me to check what the wiki already knows about
`<area>` before we design? (This records a query page in the wiki.)"*

(If `.pwiki.json` shows a `confluence` destination, add the Confluence warning below.)

On an explicit **yes**:

- Via the Skill tool, invoke `p-wiki:query` with a concise question derived from the task
  (e.g. *"What does the wiki say about `<area>` — prior decisions, constraints, patterns?"*).
- Read the cited answer. Use it to (a) avoid contradicting prior decisions, and (b) reuse
  established patterns instead of reinventing them.
- **Surface conflicts explicitly.** If the emerging spec would contradict a wiki finding,
  tell the user — quote the wiki page — and let them decide. Never silently override
  accumulated knowledge.

On **no** (or decline): continue the dialog normally. Querying is never a precondition for
producing the spec.

## Write side — `task-end` (after the push, alongside the p-tasks close offer)

Gate as above **and** require a `<slug>` resolved in `task-end` pre-check 3. Then offer:

*"Capture this task's decisions into the wiki? I'll compile `specs/<slug>/adr.md` into wiki
pages."*

(If `.pwiki.json` shows a `confluence` destination, add the Confluence warning below.)

Source-file selection — offer only files that exist, in this priority:

- `specs/<slug>/adr.md` — **preferred.** Architectural decisions are prime durable knowledge.
- `specs/<slug>/specification.md` — offer when there is no `adr.md`, or when the spec itself
  carries reusable knowledge worth keeping.
- **Never** compile `plan.md` — it is execution bookkeeping, not durable knowledge.

On an explicit **yes**: via the Skill tool, invoke `p-wiki:compile` once per chosen file with
the in-repo path (e.g. `p-wiki:compile specs/<slug>/adr.md`). Report how many pages were
created/updated.

On **no**: skip. This step **never** blocks the push or the MR recommendation — those have
already happened.

## Confirmation rules

- Every action — read or write — is an **offer**, never silent. The user may decline;
  declining is not an error and must not block the host skill.
- `Read` `<root>/docs/wiki/.pwiki.json`. If its `primary` (or any mirror) destination is
  `confluence`, the offer MUST warn: *"This writes pages to Confluence Cloud."* — and
  proceed only on an explicit yes (repo rule: external/irreversible actions need explicit
  confirmation). This applies to **both** sides: `query` writes a query page to the primary,
  and `compile` writes concept pages — if the primary is Confluence, both publish there.
- Two independent offers may fire at `task-end` (p-tasks close, then p-wiki capture). They
  are independent: order is p-tasks first, then p-wiki; neither blocks the other, and neither
  blocks the push.
