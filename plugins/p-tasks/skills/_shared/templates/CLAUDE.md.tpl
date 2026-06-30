# p-tasks data store

Tasks live in `tasks.yml` at this directory. Two-level hierarchy:
- top-level: `task` (`id: t-N`)
- nested under `subTasks`: `sub-task` (`id: st-N`)

Statuses: `todo` | `in_progress` | `done`. Use `/p-tasks:` commands to mutate.
Do not hand-edit unless you know what you are doing — id reuse is forbidden, and the canonical mutators (`/p-tasks:add`, `/p-tasks:set`) enforce structural invariants the file format does not.

## Optional fields

Beyond `id` / `title` / `description` / `status` / `blockedBy`, an item may carry these optional fields (all default to empty/absent):

- `acceptance` (string) — the step's acceptance criterion.
- `files` (string[]) — expected affected files.
- `kind` (`code` | `non-code`) — execution classification; an absent value means `code`.
- `origin` (string) — provenance: `plan` (default) | `code-review:<severity>` | `task-review:<severity>`.
- `resolution` (string) — evidence-based reason recorded when a follow-up is rejected/deferred.

Set them via `/p-tasks:add` / `/p-tasks:set` flags (`--acceptance`, `--files`, `--kind`, `--origin`, `--resolution`). Walk the whole list (any status) with `/p-tasks:list`.
