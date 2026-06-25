# p-tasks bridge (shared by writing-plan + task-end)

p-flow optionally mirrors a task into the `p-tasks` tracker — **only** when p-tasks is
initialised in this same repo. This is a one-way, opt-in courtesy: p-flow knows about
p-tasks; p-tasks knows nothing about p-flow.

## Gate — run this BEFORE any p-tasks action

1. Resolve repo root (`git rev-parse --show-toplevel`).
2. `test -f "<root>/docs/tasks/.ptasks.json"`.
   - **Absent** → p-tasks is NOT active in this repo. Do nothing, say nothing, continue
     the host skill normally. (Do not offer, do not mention p-tasks.)
   - **Present** → continue below.

## Dispatch rules

- **Never** call p-tasks' CLI directly. There is no path to p-tasks' own
  `${CLAUDE_PLUGIN_ROOT}` from inside p-flow. Always go through the **Skill tool**,
  invoking the p-tasks skills — `p-tasks:add` (create), `p-tasks:set` (close),
  `p-tasks:next --all` (enumerate open sub-tasks) — and let p-tasks resolve its own install.
- **Join key:** the p-tasks top-level `task` title is set to **exactly** the p-flow
  `<slug>`. That string is the only link — no id is stored in p-flow files. Later lookups
  resolve the task by exact title match (`p-tasks:set` does title→id resolution).
- **No status cascade in p-tasks.** Parent and sub-task statuses are independent. When
  closing a task, close its still-open sub-tasks too — otherwise they dangle open in
  `summary`/`next`. Enumerate the still-open ones with `p-tasks:next --all` filtered to this
  parent (NOT `p-tasks:summary` — `summary` returns only **done** items, so it would list
  nothing to close). Then `p-tasks:set <st-id> --status done` for each.

## Confirmation rules

- Every mirror action is an **offer**, never silent. The user may decline; declining is
  not an error and must not block the host skill.
- `Read` `<root>/docs/tasks/.ptasks.json`. If its `primary` (or mirror) destination is
  `jira`, the offer MUST warn: *"This creates real Jira issues."* — and proceed only on an
  explicit yes (repo rule: external/irreversible actions need explicit confirmation).
