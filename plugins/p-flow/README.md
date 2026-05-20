# p-flow

Workflow rules for Claude Code: secret-file deny-permissions, Conventional Commits + `<type>/<slug>` branch naming, and three specification templates (ADR, Gherkin feature, full specification).

## What `/p-flow:init` creates

In the current git repo (or current working directory if not a git repo):

- `.claude/settings.json` — `permissions.deny` patterns blocking reads/writes of common secret-bearing files (`.env*`, `*.pem`, `*.key`, `*credentials*`, `*secrets*`, SSH/AWS dotdirs, etc.). If the file already exists, the deny list is **merged** (union with dedup); no other keys are touched.
- `.claude/rules/p-flow.md` — workflow rules document: security guidance, Git workflow (Conventional Commits + `feature/<slug>` / `bugfix/<slug>` / `hotfix/<slug>` / `chore/<slug>` / `docs/<slug>`), specifications layout.
- `.claude/templates/p-flow/` — three template files (`adr.md`, `feature-spec.feature`, `specification.md`) that the team and any skills/agents in the repo use as the canonical structure for specs.

## Idempotency

`/p-flow:init` refuses if `.claude/rules/p-flow.md` already exists — the existing file is the marker. To reinitialise, delete that file and re-run.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-flow@perky.team
```

Then in any repo:

```text
/p-flow:init
```
