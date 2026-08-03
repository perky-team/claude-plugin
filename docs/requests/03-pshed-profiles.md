# Brief 03 — speed profiles

Repo: `C:\projects\perky.team\claude-plugin`, plugin `plugins/p-shed/`.
This is the largest of the four. Read brief 02 first — it settles the same file.

## Why

Today the only way to change how hard a loop works is to edit `schedule`, `model`, `effort`
and `timeoutSec` per job in `jobs.yml`. Two problems with that, both from operating the real
thing:

1. **It is a multi-step edit that is easy to leave half-applied.** Slowing a loop down means
   touching several jobs at once; a `set-job` per job is several independent writes with no
   transaction. Measured consequence of getting the pace wrong: one day burned the whole
   subscription quota by evening, and the next two days lost 70 and 16 runs to usage-limit
   skips. Pace is an operational control that gets used under pressure, and it should be one
   word.
2. **`jobs.yml` lives inside the repository the loop itself writes to.** A knob stored there
   is a knob the loop can turn. That is the wrong place for the one control that is supposed
   to belong to the operator.

## Hard requirement

**The ACTIVE profile value must be able to live outside the scheduled repository.**

The *table* — what each profile name means — may live in `jobs.yml`. It changes rarely, and
any edit to it is a visible diff that review catches. It is the *current value* that must be
storable somewhere the scheduled workload has no reason to touch.

Everything else in this brief is negotiable; this is not.

## What to build

### 1. The table, in `jobs.yml`

An optional top-level `profiles:` map — profile name → job id → partial job overrides:

```yaml
profiles:
  eco:
    worker:     { schedule: '0 */3 * * *' }
    strategist: { schedule: '20 6 * * *', model: sonnet }
    planner:    { enabled: false }
  fast:
    worker:     { schedule: '0,30 * * * *' }
```

Overridable fields: `schedule`, `model`, `effort`, `timeoutSec`, `enabled`. Validate them
with the same rules `setJob` already applies (cron parses, effort is one of the known
levels, `timeoutSec` positive) — reuse that validation, do not write a second copy of it.

### 2. Resolving the active profile

In precedence order:

1. `PSHED_PROFILE` environment variable
2. the file named by `profileFile` in `.pshed/config.json` — first line, trimmed
3. `defaults.profile` in `jobs.yml`
4. none

`readConfig` in `lib/io.mjs` already merges `.pshed/config.json` over a base object, so
`profileFile` is a natural addition there. Note that `config.json` itself lives in the repo —
that is fine and intended: it holds a *path*, and the value it points at is what lives
outside.

**A missing file, an unreadable file, or a name with no entry in `profiles:` must behave as
"no profile" and continue.** Never halt the scheduler over a profile problem. Fail toward
running: the failure mode of a stopped loop is worse than the failure mode of a loop running
at its default pace. Make the condition visible in `profile show` and `status` rather than
by refusing to tick.

### 3. Applying it

Layer the profile's per-job overrides on top of each job **in memory, at tick time**. The
job's own field is the base; the profile's value wins.

**Do not rewrite `jobs.yml`.** Rewriting it would dirty the working tree of the very
repository the loop commits to, and the loop would eventually commit the pace change as if
it were its own work.

### 4. Commands

- `pshed profile show` — the active name, **which source it came from** (env / file / default
  / none), and the effective per-job resolution. The source matters: an operator debugging
  "why is it still slow" needs to know that an env var is overriding the file.
- `pshed profile set <name>` — writes the file named by `config.profileFile`. If no
  `profileFile` is configured, **fail with a clear message**. Do not silently fall back to
  writing inside the repo; that would quietly undo the hard requirement above.
- `pshed profile list` — the names defined in `profiles:`.

### 5. `status` must not lie

`collectStatus` / `formatHuman` must report the **effective** values. If a profile disables a
job or changes its schedule, status showing the raw `jobs.yml` values would state something
the scheduler will not do. Add the active profile to the status header alongside `paused:`.

## Explicitly out of scope

**Do not build a rate limiter that stamps its own "last run" files.** That was the rejected
design: it duplicates state the scheduler already keeps in `state/<id>.json` and the run log,
and the two copies drift. The schedule override *is* the throttle.

## Acceptance

| case | expected |
|---|---|
| no profile configured anywhere | behaviour identical to today, byte for byte |
| `PSHED_PROFILE` set and a file present | env wins, `show` says so |
| only the file present | file value used, `show` names the file |
| only `defaults.profile` | used, `show` says `default` |
| profile names a job not in `jobs.yml` | ignored, not an error |
| profile name absent from `profiles:` | treated as no profile, tick still runs, visible in `show` |
| `profileFile` points at a missing/unreadable file | treated as no profile, tick still runs |
| override sets `enabled: false` | job does not launch, and `status` shows it disabled |
| override changes `schedule` | due-ness computed from the override |
| override sets an invalid cron / effort | rejected at validation with a clear message |
| `profile set` with no `profileFile` configured | fails, writes nothing |
| `jobs.yml` after any `profile set` | unchanged on disk |

Plus e2e through the CLI. Bump `plugin.json#version` (minor) and extend `description` to
name the commands and the `profiles:` key.

## Constraints

- `.claude/CLAUDE.md` applies — WSL run of the e2e suites if implemented on Windows, both
  platforms' numbers reported.
- Backwards compatible: a `jobs.yml` with no `profiles:` key must behave exactly as it does
  now. There are live installations.
- No release tag or push without explicit confirmation.
