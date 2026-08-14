# beads

A task tracker is installed in this repo. Its data lives in `.beads/`.

Use the `bd` command:
- `bd create "<title>"` — add an issue
- `bd update <id> --status=<open|in_progress|closed>` — change one
- `bd dep add <child> <parent>` — say that one blocks another
- `bd ready` — list issues with no open blockers
- `bd list` — list everything with its status

`bd init` has already been run — do not run it again.
