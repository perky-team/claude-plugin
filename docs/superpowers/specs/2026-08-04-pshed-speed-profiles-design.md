# p-shed speed profiles — design

Date: 2026-08-04
Requirement: [`docs/requests/03-pshed-profiles.md`](../../requests/03-pshed-profiles.md)
Plugin: `plugins/p-shed/`

## Problem

Changing how hard the loop works means editing `schedule` / `model` / `effort` /
`timeoutSec` per job in `jobs.yml`. Two measured problems:

1. **It is a multi-job edit with no transaction.** Slowing the loop down is several
   independent `set-job` writes, easy to leave half-applied. Getting the pace wrong once
   burned the whole subscription quota by evening, and the next two days lost 70 and 16
   runs to usage-limit skips. Pace is an operational control used under pressure — it
   should be one word.
2. **`jobs.yml` lives inside the repository the loop writes to.** A knob stored there is
   a knob the loop can turn.

## Hard requirement

**The ACTIVE profile value must be able to live outside the scheduled repository.** The
*table* (what each name means) may live in `jobs.yml` — it changes rarely and every edit
is a reviewable diff. It is the *current value* that must be storable where the scheduled
workload has no reason to write.

## Architecture

```
 jobs.yml (in the repo)                .pshed/config.json        OUTSIDE the repo
┌───────────────────────────┐        ┌────────────────────┐     ┌──────────────────┐
│ defaults:                 │        │ "profileFile":     │────▶│ /var/lib/pshed/  │
│   profile: eco     ← (3)  │        │  "/var/lib/..."    │     │   profile        │
│ profiles:      ← the table│        └────────────────────┘     │   eco       ← (2) │
│   eco: { worker: {...} }  │                                    └──────────────────┘
│ jobs: [...]    ← the base │            PSHED_PROFILE=fast ← (1)
└───────────────────────────┘
              │
              ▼
   resolveProfile()   precedence (1) env → (2) file → (3) defaults.profile → none
              │       → { name, source, file?, problem? }
              ▼
   applyProfile(jobs, table, name)     IN MEMORY ONLY — jobs.yml is never rewritten
              │
      ┌───────┼────────┬─────────┐
      ▼       ▼        ▼
    tick    status    run          one resolution point, so status cannot lie
```

### New module: `lib/profile.mjs`

| function | contract |
|---|---|
| `readProfileValue(path)` | first line of the file, trimmed; `null` on missing / unreadable / empty. Never throws. |
| `resolveProfile({ root, jobsData, config, env })` | `{ name, source, file?, problem?, warning? }`. `source` ∈ `env` \| `file` \| `default` \| `none`. `name` is whatever was found — including a name absent from the table — and is `null` only when `source` is `none`. `problem` is `unknown-name` and means **the overrides are not applied**. `warning` is `file-missing` \| `file-unreadable`: the configured file could not be read, so resolution fell through to `defaults.profile`; whatever name that yields is still applied. Two fields rather than one because a broken `profileFile` and an unresolvable name have opposite consequences — one keeps a valid profile active, the other cannot. |
| `validateProfiles(table)` | throws `ValidationError` listing the offending profile/job/field. Called only from CLI commands. |
| `applyProfile(jobs, table, name)` | returns a NEW job array with the profile's per-job overrides layered on top. Never mutates its input. |
| `effectiveJobs({ root, jobsData, config, env })` | convenience: resolve + apply, returning `{ jobs, profile }`. The single seam tick / status / run use. |

Overridable fields: `schedule`, `model`, `effort`, `timeoutSec`, `enabled`. An unknown key
in a profile entry is **an error at the human surfaces and ignored by the tick** — the same
split as invalid values below. A silently ignored `schedul:` typo is exactly the
under-pressure failure this feature exists to prevent, while an older p-shed must still
tick against a newer table rather than halt.

### Resolution rules

- Precedence is strictly `PSHED_PROFILE` → `config.profileFile` contents →
  `defaults.profile` → none. An env value that is empty or whitespace counts as unset and
  falls through, so `PSHED_PROFILE=` cannot silently mean "profile named empty string".
- `profileFile` may be absolute or relative; a relative path resolves against the repo
  root, like every other path in `config.json`.
- **An empty or whitespace-only file falls through to `defaults.profile`**, exactly like
  an unset env var. The file holds "the operator's current choice"; no choice written is
  not a choice to have no profile.
- **A missing file, an unreadable file, or a name absent from `profiles:` behaves as "no
  profile" and the tick continues.** The condition is reported (`problem` / `warning`) in
  `profile show` and `status`, never by refusing to tick. Fail toward running: a stopped
  loop is a worse failure than a loop running at its default pace.

### Validation: strict where a human is, lenient on the tick

Decided explicitly, because the requirement asks for both.

| surface | behaviour |
|---|---|
| `profile show` / `list` / `set` | `validateProfiles` runs; an invalid cron / effort / `timeoutSec` / `enabled` fails the command with a message naming profile, job and field. |
| `tick` / `status` / `run` | an invalid override for one field is **dropped**; the job keeps its own base value and the scheduler runs. |

The validation rules themselves are `setJob`'s, extracted into a shared exported helper in
`lib/jobs.mjs` (`validateJobFields`, alongside the existing `ValidationError`) which
`profile.mjs` imports — not copied. A second copy of "which efforts exist" is exactly how
the two drift apart. `jobs.mjs` does not import `profile.mjs`, so there is no cycle.

### Applying

`applyProfile` layers per job: the job's own field is the base, the profile's value wins.
For `run <id>` this means `model` / `effort` / `timeoutSec` come from the profile, while
`schedule` and `enabled` change nothing — `run` already ignores both by design (it is the
"run this now regardless" command), and a profile must not turn it into a refusal.
`jobs.yml` is **never** rewritten. Rewriting it would dirty the working tree of the
repository the loop commits to, and the loop would eventually commit the pace change as if
it were its own work.

### Commands

- `pshed profile show [--human]` — the active name, **which source it came from**, the
  file path when the source is a file, any `problem`, and the effective per-job resolution
  (only the fields the profile changes, as `from → to`). The source matters: an operator
  debugging "why is it still slow" needs to see that an env var overrides the file.
- `pshed profile set <name>` — writes the file named by `config.profileFile`. **Fails when
  no `profileFile` is configured** — never falls back to writing inside the repo, which
  would quietly undo the hard requirement. **Also fails when `<name>` is not in
  `profiles:`**, listing the known names: the same fail-loud reasoning as `resolveTarget`,
  where a typo used to silently widen a blast radius.
- `pshed profile list` — the names defined in `profiles:`.

### `status` must not lie

`collectStatus` reports the **effective** values (a profile that disables a job shows it
disabled; an overridden schedule is the one due-ness is computed from) and gains a
`profile` object; `formatHuman` gains a `profile:` header line next to `paused:`.

## Two required side-fixes

1. **`readJobs` drops unknown top-level keys**, and `setJob` writes back exactly what it
   read — so a `profiles:` block would be silently deleted by the next `set-job` / `rm-job`.
   `readJobs` must carry it through and `writeJobs` must preserve it. Without this the
   feature destroys its own table.
2. **Validation extraction** (above) so `profiles:` and `set-job` cannot disagree about
   what a valid `effort` is.

## Out of scope

**No rate limiter that stamps its own "last run" files.** That was the rejected design: it
duplicates state the scheduler already keeps in `state/<id>.json` and the run log, and the
two copies drift. The schedule override *is* the throttle.

## Testing

| file | covers |
|---|---|
| `__tests__/profile.test.ts` | resolution precedence, all four sources, every `problem`, `applyProfile` layering, unknown-field tolerance, invalid-field dropping, immutability of the input |
| `__tests__/tick-profile.test.ts` | due-ness from an overridden schedule, `enabled: false` suppressing a launch, a job absent from the profile untouched, no `profiles:` key = byte-for-byte today's behaviour, a broken profile still ticking |
| `__tests__/status-profile.test.ts` | effective values in `collectStatus`, the `profile:` header, `problem` surfaced |
| `__tests__/cli-profile-e2e.test.ts` | `show` / `set` / `list` through the real CLI, `set` refusing without `profileFile`, `set` refusing an unknown name, `jobs.yml` unchanged on disk after `set` |
| `__tests__/jobs.test.ts` | regression: `set-job` preserves an existing `profiles:` block |

Backwards compatibility is a test, not a hope: a `jobs.yml` with no `profiles:` key must
behave exactly as it does today. There are live installations.
