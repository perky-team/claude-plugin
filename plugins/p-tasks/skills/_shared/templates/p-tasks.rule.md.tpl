# p-tasks

A task tracker plugin is installed in this repo at `docs/tasks/tasks.yml`.

Slash commands:
- `/p-tasks:add` — create a task or sub-task
- `/p-tasks:set <id>` — change status, title, description, or blockers
- `/p-tasks:next` — return the next unblocked item
- `/p-tasks:summary [<id>]` — list done items
- `/p-tasks:sync` — push primary state to all mirrors

`/p-tasks:init` is one-shot — do not re-run it.
