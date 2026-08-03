# Brief 04 — `install-cron` should not pin the plugin version into crontab

Repo: `C:\projects\perky.team\claude-plugin`, plugin `plugins/p-shed/`.
Independent of briefs 01–03; can be done at any point.

## Why

`crontabLine` in `lib/scheduler.mjs` writes the caller's `toolPath` straight into the
crontab:

```js
export function crontabLine({ root, nodeBin, toolPath }) {
  return `* * * * * cd "${root}" && "${nodeBin}" "${toolPath}" tick > "${root}/.pshed/logs/cron.log" 2>&1 # ${taskName(root)}`;
}
```

In practice `toolPath` is the versioned plugin cache path, so the installed line reads:

```
* * * * * cd "/home/andrey/projects/quasarfx/hft" && "/usr/bin/node" \
  "/home/andrey/.claude/plugins/cache/perky-team/p-shed/0.10.0/tools/pshed.mjs" tick ...
```

That line names a directory the plugin system considers disposable. Measured on the live
Pi on 2026-08-03:

- `~/.claude/plugins/installed_plugins.json` registers **p-shed 0.9.0** as installed.
- The `p-shed/0.10.0/` cache directory — the one the crontab invokes every minute — carries
  an `.orphaned_at` marker written 2026-08-03 08:51.
- The same is true of every other hand-installed version there: p-tasks 1.1.3, p-chat 0.1.1,
  p-graph 0.7.1, p-wiki 4.12.3. There is a sweep mechanism (`.last_inuse_sweep`, last run
  2026-08-03 15:20Z).

**Honest status of the risk:** orphan markers dated 2026-07-22 are still on disk twelve days
later, so no sweep has actually deleted anything. The risk is real but has never been
observed, and this brief should be read as "remove a dependency that buys nothing", not as
an emergency.

There is already a working pattern in the same ecosystem — a wrapper on the Pi resolves the
newest installed version at call time:

```bash
exec /usr/bin/node "$(ls -d "$HOME"/.claude/plugins/cache/perky-team/p-chat/*/tools/pchat.mjs | sort -V | tail -1)" "$@"
```

Every operator ends up writing that by hand. The scheduler that generates the crontab line
is the right place for it.

## What to build

`install-cron` should emit a line that keeps working when the plugin version changes.

Weigh the options and justify the choice rather than taking the first one:

1. **Resolve at call time** inside the generated line (the pattern above). No extra files;
   the line gets longer and harder to read.
2. **A stable path** — install-cron maintains a symlink (e.g. `~/.local/share/pshed/current`)
   and points cron at it. Readable line; adds a file to manage and to clean up on
   `remove-cron`.
3. **Resolve via the plugin registry** — read `installed_plugins.json`. Most "correct" in
   principle, but it is exactly the file that was *wrong* in the measured case above, so it
   would have pointed at 0.9.0 while 0.10.0 was the one in use. Mentioned so it can be ruled
   out on evidence rather than by omission.

Hard constraint: **cron runs with a stripped `PATH`.** Whatever is generated must not assume
`node`, the plugin CLI, or anything else is resolvable by name.

## Do not break existing installs

`remove-cron` and `stop` locate their line by the `# pshed-<sha1>` marker via
`scanCrontabTaskIds` / `crontabHasTask`. Whatever shape the new line takes, that marker must
stay in the same position and format, and both functions must still match lines written by
**older** versions of p-shed. An upgrade that leaves an operator unable to remove their own
cron entry is worse than the problem being fixed.

Windows note: `buildInstall` produces the schtasks equivalent and has the same issue. Fix it
consistently or state explicitly why it is out of scope.

## Acceptance

| case | expected |
|---|---|
| line generated, plugin version directory then renamed | the line still resolves and runs |
| generated line run with a stripped `PATH` | works |
| crontab written by an older p-shed | still found by `crontabHasTask` and removed by `remove-cron` |
| `remove-cron` after the new-style install | removes exactly one line, leaves others |
| `scanCrontabTaskIds` over a mixed old/new crontab | finds both |

Existing tests in `scheduler.test.ts` must be updated rather than deleted — if an assertion
pinned the old literal path, replace it with one that pins the *contract* (the marker, the
cwd, the `tick` argument), not the spelling.

Bump `plugin.json#version` (patch or minor depending on the shape chosen) and note it in
`description` if the install behaviour changes visibly.

## Constraints

- `.claude/CLAUDE.md` applies — WSL run of the e2e suites if implemented on Windows, both
  platforms' numbers reported. This one especially: `install-cron` is POSIX-only logic with a
  separate win32 branch, so a Windows-only run proves very little about it.
- No release tag or push without explicit confirmation.
