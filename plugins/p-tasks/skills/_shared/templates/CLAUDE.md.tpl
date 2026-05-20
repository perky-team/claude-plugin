# p-tasks data store

Tasks live in `tasks.yml` at this directory. Two-level hierarchy:
- top-level: `task` (`id: t-N`)
- nested under `subTasks`: `sub-task` (`id: st-N`)

Statuses: `todo` | `in_progress` | `done`. Use `/p-tasks:` commands to mutate.
Do not hand-edit unless you know what you are doing — id reuse is forbidden, and the canonical mutators (`/p-tasks:add`, `/p-tasks:set`) enforce structural invariants the file format does not.
