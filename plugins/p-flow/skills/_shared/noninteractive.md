# Non-interactive mode (shared by p-flow skills that put questions to the user)

Most p-flow skills assume a human at the keyboard. The same skills are useful inside a headless
`claude -p` run — a p-shed worker job, a CI step — where nobody can answer. This doc is the single
gate that tells a skill which of the two situations it is in, and the one rule it must follow when
there is no user.

## Gate — run this BEFORE putting any question to the user

```sh
test "${P_FLOW_NONINTERACTIVE:-}" = "1"
```

- **Exit 0** — the variable is set to exactly `1` → **non-interactive mode**. Follow the rule below
  and the host skill's documented defaults.
- **Anything else** — unset, empty, `0`, `true`, `yes`, any other value → **interactive mode**.
  Behave **exactly** as before this doc existed: put every question the host skill puts, in the same
  words, in the same order. Say nothing about this gate — silent no-op. This path must be
  byte-for-byte unchanged.

The accepted value is deliberately narrow. A typo (`P_FLOW_NONINTERACTIVE=ture`) degrades to the
safe mode — asking a human — rather than silently deciding on their behalf.

## The rule

In non-interactive mode a skill **never asks**. Wherever the interactive path would put a question
to the user, it does exactly one of two things:

1. **Applies the documented default.** The default must already be written down in the host skill,
   next to the question it replaces. A default invented at runtime is not a default.
2. **Fails loudly with a named reason.** Stop, and state in one line — the line the job's log will
   carry — which precondition or decision could not be satisfied and why. A named failure is always
   preferable to a guess.

**It must never invent an answer on the user's behalf on a question that is the user's to decide.**
Accepting work, deferring work, or ordering work can be defaulted. A judgement about whether a
finding is *wrong*, or a consent to an external irreversible write, cannot — those belong to the
user. When it is unclear which kind a question is, treat it as the user's and fail.

Two corollaries:

- **The audit trail has the same shape in both modes.** A decision the policy made is recorded
  through the same mechanism, with the same fields, as a decision the user made. A later reader
  cannot tell them apart structurally — only by the reason recorded against them.
- **A closing statement addressed to the user is emitted, never awaited.** *"When ready, say
  'continue'"* is output, not a prompt. Nothing in non-interactive mode blocks on input.

## Hosts

| Skill | What the gate changes | Documented defaults |
|---|---|---|
| `requesting-code-review` | precondition 3 (spec file / parent-task resolution) and the §4 triage protocol | `skills/requesting-code-review/SKILL.md` |

No other skill reads this doc yet. Adding one means writing that skill's defaults into that skill
first — this doc supplies the gate and the rule, never the defaults.
