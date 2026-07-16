# p-shed Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `p-shed`, a Claude Code plugin (tool `pshed`) that schedules and launches headless `claude -p` runs on a cron schedule, with per-job timeout, a duplicate guard, missed-tick catch-up, and log rotation.

**Architecture:** A Node ESM CLI (`tools/pshed.mjs`) is a thin dispatcher over small single-responsibility modules under `tools/lib/`. An OS scheduler entry (Windows `schtasks`, POSIX `crontab`) calls `pshed tick` every minute; `tick` reads declarative jobs, decides which are due, and launches `claude -p` in each job's folder. Four skills (`init`, `start`, `stop`, `job`) drive setup and management. p-shed is a pure scheduler — it never stores or resolves work items, writes no rule, and does not touch any other plugin.

**Tech Stack:** Node ≥ 18 (ESM), vitest for tests, `js-yaml` (vendored — no `npm install` at the user site), OS schedulers `schtasks`/`crontab`.

## Global Constraints

- All created files are in **English** (repo rule).
- **Do not modify p-flow** — no p-flow files touched, no p-flow tests added or changed.
- No task storage, no dual-mode task-store logic, no `worklist.yml`, **no rule file** written by `init`.
- No task deletion/pruning; no budget cap; **no cross-job lock** (keep the per-job duplicate guard).
- Every CLI command supports `--json`; `--version` prints the tool version; exit codes: `0` ok, `1` environment error, `2` validation error.
- Runtime dependencies must be **vendored** into `tools/lib/vendor/` (only `js-yaml`). Import vendored yaml as `import yaml from './vendor/js-yaml.mjs'` then `yaml.load` / `yaml.dump`.
- Plugin version starts at `0.1.0`.
- **Timeout is mandatory**, configurable per job, default `900` seconds.
- Tests: repo-wide tests live in `tests/*.test.ts`; tool unit tests live in `plugins/p-shed/tools/__tests__/*.test.ts` (both are picked up by `vitest.config.ts`).

### File / responsibility map

```
plugins/p-shed/
├── .claude-plugin/plugin.json      manifest (name, version, description, author)
├── README.md                       user docs: commands, formats, limitations
├── CLAUDE.md                       contributor notes (key decisions)
├── scripts/vendor-deps.mjs         copies js-yaml ESM build into tools/lib/vendor/
├── tools/
│   ├── pshed.mjs                   CLI dispatcher + parseArgs/findRoot/emitJson/die
│   ├── lib/
│   │   ├── io.mjs                  read/write jobs.yml, config.json, state.json + paths
│   │   ├── cron.mjs               5-field cron matcher + isDue (catch-up)
│   │   ├── jobs.mjs               setJob / rmJob + cron validation + stable ids
│   │   ├── logs.mjs               appendLog + rotateLogs (7-day retention)
│   │   ├── launch.mjs             buildArgs + runJob (spawn, timeout, tree-kill)
│   │   ├── tick.mjs               orchestration: due calc, dup guard, launch, persist
│   │   ├── scheduler.mjs          install/remove OS scheduler entry (schtasks|crontab)
│   │   └── vendor/js-yaml.mjs     vendored dependency (generated)
│   └── __tests__/                  vitest unit tests
└── skills/
    ├── init/SKILL.md
    ├── start/SKILL.md
    ├── stop/SKILL.md
    └── job/SKILL.md
```

**Format decision (reconciles the spec's redundant `defaults`):** declarative defaults live in `jobs.yml` `defaults`; `config.json` holds only machine-resolved binaries (`nodeBin`, `claudeBin`). `config.json`, `state.json`, `logs/`, `run/` are gitignored; `jobs.yml` is tracked.

- `jobs.yml` (git): `{ version, defaults: { cwd, timeoutSec, permissionMode, allowedTools }, jobs: [ { id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools? } ] }`
- `config.json` (gitignore): `{ nodeBin, claudeBin }`
- `state.json` (gitignore): `{ jobs: { <id>: { lastRun, lastExit, pid } } }`
- `logs/<date>.jsonl` (gitignore): one JSON record per run
- `run/<id>.pid` (gitignore): duplicate-guard pidfile

---

### Task 1: Plugin skeleton & manifest

**Files:**
- Create: `plugins/p-shed/.claude-plugin/plugin.json`
- Create: `plugins/p-shed/README.md`
- Create: `plugins/p-shed/CLAUDE.md`
- Modify: `.claude-plugin/marketplace.json` (add the `p-shed` entry)

**Interfaces:**
- Produces: a discoverable plugin dir named `p-shed` with a valid manifest; consumed by the existing `tests/plugin-manifests.test.ts` and `tests/marketplace.test.ts`.

- [ ] **Step 1: Write the manifest**

`plugins/p-shed/.claude-plugin/plugin.json`:
```json
{
  "name": "p-shed",
  "version": "0.1.0",
  "description": "Scheduler/launcher for Claude Code headless runs. Cron-scheduled jobs launch `claude -p` in a folder, with per-job timeout, duplicate guard, missed-tick catch-up, and log rotation. Pure scheduler — no task storage. Commands (tool `pshed`): tick, run, install-cron, remove-cron, set-job, rm-job. Skills: init, start, stop, job.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 2: Register in the marketplace**

Add to the `plugins` array in `.claude-plugin/marketplace.json` (after the `p-graph` entry):
```json
{
  "name": "p-shed",
  "source": "./plugins/p-shed",
  "description": "Scheduler/launcher for Claude Code headless runs: cron-scheduled `claude -p` launches with timeout, duplicate guard, catch-up, and log rotation. Skills: init, start, stop, job."
}
```

- [ ] **Step 3: Write a minimal README**

`plugins/p-shed/README.md` — include a `## Skills` section listing all four skills in backticks (required by `tests/plugin-readme-coverage.test.ts`), plus placeholders for Commands and Formats to be filled in Task 11:
```markdown
# p-shed

Scheduler/launcher for Claude Code headless runs. `p-shed` schedules **jobs** (cron
timer + folder + prompt) and, on each due minute, launches `claude -p` in the job's
folder. It is a pure scheduler: it does not store or resolve work items and installs
no rules — what to do lives entirely in each job's prompt and in the target folder.

## Skills

| Skill | Purpose |
|---|---|
| `p-shed:init` | Scaffold `.pshed/` in the current folder. |
| `p-shed:start` | Install the every-minute OS scheduler entry (`pshed tick`). |
| `p-shed:stop` | Remove the OS scheduler entry. |
| `p-shed:job` | Add, modify, or delete a scheduled job. |

## Commands

_Filled in Task 11._

## Formats

_Filled in Task 11._

## Known limitations

- A job runs in its `cwd`; only that folder's `.claude/rules` load. To target another
  project, set the job's `cwd` there (its own setup takes over) or put full
  instructions in the prompt.
- Requires the OS scheduler (`schtasks` on Windows, user `crontab` on Linux/macOS) and
  `node` + `claude` resolvable at install time.
```

- [ ] **Step 4: Write a minimal CLAUDE.md**

`plugins/p-shed/CLAUDE.md`:
```markdown
# p-shed — contributor guide

Pure scheduler/launcher. Key decisions:

- **Built-in cron matcher** (`tools/lib/cron.mjs`), not `cron-parser`: plugins ship as
  a plain file copy with no `npm install`, so deps must be vendored; `cron-parser`
  pulls transitive deps (luxon). Minute-granularity matching + catch-up is small and
  self-contained.
- **Duplicate guard, not a lock:** a per-job pidfile (`.pshed/run/<id>.pid`) skips a
  launch while the previous run is alive. No cross-job lock.
- **Timeout is the recovery mechanism:** because runs are unattended and the duplicate
  guard skips live runs, a hung run would wedge the job forever; the timeout kills the
  process tree so the next tick recovers.
- **No task storage, no rule:** p-shed never reads/writes work items and `init` writes
  no `.claude/rules` file. It does not depend on or modify any other plugin.
- Deps vendored via `scripts/vendor-deps.mjs` (js-yaml only), same pattern as p-tasks.
```

- [ ] **Step 5: Run the manifest/marketplace tests**

Run: `npx vitest run tests/plugin-manifests.test.ts tests/marketplace.test.ts tests/plugin-readme-coverage.test.ts`
Expected: PASS (the new plugin's manifest, marketplace entry, and README skill coverage validate).

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/.claude-plugin/plugin.json plugins/p-shed/README.md plugins/p-shed/CLAUDE.md .claude-plugin/marketplace.json
git commit -m "feat(p-shed): plugin skeleton, manifest, marketplace entry"
```

---

### Task 2: CLI entry & argument parsing

**Files:**
- Create: `plugins/p-shed/tools/pshed.mjs`
- Test: `plugins/p-shed/tools/__tests__/cli-entry.test.ts`

**Interfaces:**
- Produces: `parseArgs(argv: string[]) => { _: string[], [flag]: string|boolean|string[] }`, `findRoot(startDir: string) => string`, `emitJson(obj, exitCode)`, `die(message, exitCode)`, `VERSION: string`. A `main()` dispatcher that recognizes commands `tick`, `run`, `install-cron`, `remove-cron`, `set-job`, `rm-job` and exits `1` on unknown command.

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/cli-entry.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from '../pshed.mjs';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');
const run = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });

describe('parseArgs', () => {
  it('parses positionals and flags', () => {
    expect(parseArgs(['run', 'job1', '--json'])).toEqual({ _: ['run', 'job1'], json: true });
  });
  it('parses --key=value', () => {
    expect(parseArgs(['--id=task-runner'])).toEqual({ _: [], id: 'task-runner' });
  });
});

describe('cli entry', () => {
  it('prints version', () => {
    expect(run(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('unknown command exits non-zero', () => {
    expect(() => run(['frobnicate'])).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-entry.test.ts`
Expected: FAIL (cannot resolve `../pshed.mjs`).

- [ ] **Step 3: Write the CLI entry**

`plugins/p-shed/tools/pshed.mjs`:
```javascript
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[key] = true;
        } else {
          if (key in out) out[key] = [].concat(out[key], next);
          else out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function findRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function emitJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

export function die(message, exitCode = 1) {
  process.stderr.write(message + '\n');
  process.exit(exitCode);
}

const KNOWN = ['tick', 'run', 'install-cron', 'remove-cron', 'set-job', 'rm-job'];

async function main() {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  // Commands are wired in Task 10.
  die(`command ${command} not implemented yet`, 1);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-entry.test.ts
git commit -m "feat(p-shed): CLI entry, arg parsing, version"
```

---

### Task 3: Vendor js-yaml & I/O module

**Files:**
- Create: `plugins/p-shed/scripts/vendor-deps.mjs`
- Create: `plugins/p-shed/tools/lib/vendor/js-yaml.mjs` (generated by the script)
- Create: `plugins/p-shed/tools/lib/io.mjs`
- Test: `plugins/p-shed/tools/__tests__/io.test.ts`

**Interfaces:**
- Produces: `paths(root) => { dir, jobs, config, state, logsDir, runDir }` (absolute paths under `<root>/.pshed`); `readJobs(root) => { version, defaults, jobs }` (defaults `{}` and `jobs []` when the file is missing); `writeJobs(root, data)`; `readConfig(root) => { nodeBin, claudeBin }`; `readState(root) => { jobs: {} }`; `writeState(root, state)`. All file writes create parent dirs.

- [ ] **Step 1: Write the vendor script**

`plugins/p-shed/scripts/vendor-deps.mjs`:
```javascript
// Vendors js-yaml's self-contained ESM build into tools/lib/vendor/.
// Plugins are distributed by copying files with NO install step, so a bare
// `import 'js-yaml'` would fail once the plugin is copied alone. Re-run after
// bumping js-yaml in the root package.json:
//   node plugins/p-shed/scripts/vendor-deps.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'tools', 'lib', 'vendor');
mkdirSync(vendor, { recursive: true });
const pkgDir = dirname(require.resolve('js-yaml/package.json'));
copyFileSync(join(pkgDir, 'dist', 'js-yaml.mjs'), join(vendor, 'js-yaml.mjs'));
console.log('vendored js-yaml -> tools/lib/vendor/js-yaml.mjs');
```

- [ ] **Step 2: Run the vendor script**

Run: `node plugins/p-shed/scripts/vendor-deps.mjs`
Expected: prints `vendored js-yaml -> tools/lib/vendor/js-yaml.mjs`; file `plugins/p-shed/tools/lib/vendor/js-yaml.mjs` exists.

- [ ] **Step 3: Write the failing test**

`plugins/p-shed/tools/__tests__/io.test.ts`:
```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJobs, writeJobs, readState, writeState, readConfig, paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-io-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('io', () => {
  it('readJobs returns empty defaults when missing', () => {
    expect(readJobs(root)).toEqual({ version: 1, defaults: {}, jobs: [] });
  });
  it('writeJobs round-trips through YAML', () => {
    const data = { version: 1, defaults: { timeoutSec: 900 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] };
    writeJobs(root, data);
    expect(readJobs(root)).toEqual(data);
  });
  it('state round-trips through JSON', () => {
    writeState(root, { jobs: { a: { lastRun: 111, lastExit: 0, pid: null } } });
    expect(readState(root)).toEqual({ jobs: { a: { lastRun: 111, lastExit: 0, pid: null } } });
  });
  it('readConfig defaults nodeBin/claudeBin', () => {
    expect(readConfig(root)).toEqual({ nodeBin: 'node', claudeBin: 'claude' });
  });
  it('paths are under <root>/.pshed', () => {
    expect(paths(root).jobs).toBe(join(root, '.pshed', 'jobs.yml'));
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/io.test.ts`
Expected: FAIL (cannot resolve `../lib/io.mjs`).

- [ ] **Step 5: Write the I/O module**

`plugins/p-shed/tools/lib/io.mjs`:
```javascript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from './vendor/js-yaml.mjs';

export function paths(root) {
  const dir = join(root, '.pshed');
  return {
    dir,
    jobs: join(dir, 'jobs.yml'),
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    logsDir: join(dir, 'logs'),
    runDir: join(dir, 'run'),
  };
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function readJobs(root) {
  const p = paths(root).jobs;
  if (!existsSync(p)) return { version: 1, defaults: {}, jobs: [] };
  const data = yaml.load(readFileSync(p, 'utf-8')) || {};
  return { version: data.version ?? 1, defaults: data.defaults ?? {}, jobs: data.jobs ?? [] };
}

export function writeJobs(root, data) {
  writeFile(paths(root).jobs, yaml.dump(data));
}

export function readConfig(root) {
  const p = paths(root).config;
  const base = { nodeBin: 'node', claudeBin: 'claude' };
  if (!existsSync(p)) return base;
  return { ...base, ...JSON.parse(readFileSync(p, 'utf-8')) };
}

export function readState(root) {
  const p = paths(root).state;
  if (!existsSync(p)) return { jobs: {} };
  const data = JSON.parse(readFileSync(p, 'utf-8'));
  return { jobs: data.jobs ?? {} };
}

export function writeState(root, state) {
  writeFile(paths(root).state, JSON.stringify(state, null, 2) + '\n');
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/io.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-shed/scripts/vendor-deps.mjs plugins/p-shed/tools/lib/vendor/js-yaml.mjs plugins/p-shed/tools/lib/io.mjs plugins/p-shed/tools/__tests__/io.test.ts
git commit -m "feat(p-shed): vendor js-yaml and add I/O module"
```

---

### Task 4: Cron matcher & due calculation

**Files:**
- Create: `plugins/p-shed/tools/lib/cron.mjs`
- Test: `plugins/p-shed/tools/__tests__/cron.test.ts`

**Interfaces:**
- Produces: `parseCron(expr: string) => Cron` (throws on a non-5-field expression); `matches(cron: Cron, date: Date) => boolean`; `isDue(cron: Cron, lastRunMs: number, nowMs: number) => boolean` (true iff at least one whole minute in `(lastRunMs, nowMs]`, capped to the last 24h, matches — so several missed minutes collapse to a single due signal).

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/cron.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { parseCron, matches, isDue } from '../lib/cron.mjs';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe('parseCron', () => {
  it('rejects non-5-field expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
  });
});

describe('matches', () => {
  it('every minute', () => {
    expect(matches(parseCron('* * * * *'), at(2026, 7, 16, 3, 7))).toBe(true);
  });
  it('specific minute/hour', () => {
    const c = parseCron('30 2 * * *');
    expect(matches(c, at(2026, 7, 16, 2, 30))).toBe(true);
    expect(matches(c, at(2026, 7, 16, 2, 31))).toBe(false);
  });
  it('step values', () => {
    const c = parseCron('*/15 * * * *');
    expect(matches(c, at(2026, 7, 16, 1, 0))).toBe(true);
    expect(matches(c, at(2026, 7, 16, 1, 15))).toBe(true);
    expect(matches(c, at(2026, 7, 16, 1, 7))).toBe(false);
  });
  it('ranges and lists', () => {
    const c = parseCron('0 9-17 * * 1,3', );
    expect(matches(c, at(2026, 7, 13, 9, 0))).toBe(true);   // Monday
    expect(matches(c, at(2026, 7, 14, 9, 0))).toBe(false);  // Tuesday
  });
});

describe('isDue', () => {
  it('true when a matching minute passed since lastRun', () => {
    const c = parseCron('*/15 * * * *');
    const last = at(2026, 7, 16, 1, 5).getTime();
    const now = at(2026, 7, 16, 1, 20).getTime();
    expect(isDue(c, last, now)).toBe(true);   // 1:15 matched
  });
  it('false when no matching minute passed', () => {
    const c = parseCron('*/15 * * * *');
    const last = at(2026, 7, 16, 1, 16).getTime();
    const now = at(2026, 7, 16, 1, 20).getTime();
    expect(isDue(c, last, now)).toBe(false);
  });
  it('collapses several missed matches to a single due signal', () => {
    const c = parseCron('* * * * *');
    const last = at(2026, 7, 16, 1, 0).getTime();
    const now = at(2026, 7, 16, 1, 30).getTime();
    expect(isDue(c, last, now)).toBe(true);   // one boolean, not 30 launches
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cron.test.ts`
Expected: FAIL (cannot resolve `../lib/cron.mjs`).

- [ ] **Step 3: Write the cron module**

`plugins/p-shed/tools/lib/cron.mjs`:
```javascript
function fieldMatcher(field, min, max) {
  const parts = field.split(',');
  const ranges = parts.map((p) => {
    let step = 1;
    let range = p;
    const slash = p.indexOf('/');
    if (slash !== -1) { step = parseInt(p.slice(slash + 1), 10); range = p.slice(0, slash); }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = parseInt(a, 10); hi = parseInt(b, 10); }
    else { lo = hi = parseInt(range, 10); }
    if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(step) || step < 1) {
      throw new Error(`invalid cron field: ${field}`);
    }
    return { lo, hi, step };
  });
  return (v) => ranges.some(({ lo, hi, step }) => v >= lo && v <= hi && (v - lo) % step === 0);
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron: expected 5 fields, got ${fields.length}`);
  const [mi, hr, dom, mon, dow] = fields;
  return {
    raw: { dom, dow },
    minute: fieldMatcher(mi, 0, 59),
    hour: fieldMatcher(hr, 0, 23),
    dom: fieldMatcher(dom, 1, 31),
    month: fieldMatcher(mon, 1, 12),
    dow: fieldMatcher(dow, 0, 6),
  };
}

export function matches(cron, date) {
  if (!cron.minute(date.getMinutes())) return false;
  if (!cron.hour(date.getHours())) return false;
  if (!cron.month(date.getMonth() + 1)) return false;
  const domR = cron.raw.dom !== '*';
  const dowR = cron.raw.dow !== '*';
  const d = cron.dom(date.getDate());
  const w = cron.dow(date.getDay());
  // Standard cron: when both day-of-month and day-of-week are restricted, either may match.
  return domR && dowR ? (d || w) : (d && w);
}

export function isDue(cron, lastRunMs, nowMs) {
  const MIN = 60_000;
  const start = Math.max(lastRunMs ?? 0, nowMs - 24 * 60 * MIN);
  let t = Math.floor(start / MIN) * MIN + MIN;      // first whole minute after start
  const end = Math.floor(nowMs / MIN) * MIN;        // current whole minute
  for (; t <= end; t += MIN) {
    if (matches(cron, new Date(t))) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cron.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/cron.mjs plugins/p-shed/tools/__tests__/cron.test.ts
git commit -m "feat(p-shed): built-in cron matcher and due calculation"
```

---

### Task 5: Job mutation (set-job / rm-job)

**Files:**
- Create: `plugins/p-shed/tools/lib/jobs.mjs`
- Test: `plugins/p-shed/tools/__tests__/jobs.test.ts`

**Interfaces:**
- Consumes: `readJobs`/`writeJobs` from `io.mjs`; `parseCron` from `cron.mjs`.
- Produces: `setJob(root, spec) => { id, created: boolean }` where `spec = { id?, schedule, prompt, enabled?, cwd?, timeoutSec?, permissionMode?, allowedTools? }` — validates the cron expression (throws `ValidationError` on a bad expr or a missing `schedule`/`prompt` for a new job), generates a stable slug id from the prompt when `id` is absent, and updates in place when `id` matches an existing job; `rmJob(root, id) => boolean` (false if not found); `slugify(text) => string`; `class ValidationError extends Error`.

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/jobs.test.ts`:
```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setJob, rmJob, slugify, ValidationError } from '../lib/jobs.mjs';
import { readJobs } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-jobs-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('slugify', () => {
  it('kebab-cases and truncates', () => {
    expect(slugify('Take the Next Item!')).toBe('take-the-next-item');
  });
});

describe('setJob', () => {
  it('rejects a bad cron expression', () => {
    expect(() => setJob(root, { schedule: 'nope', prompt: 'x' })).toThrow(ValidationError);
  });
  it('creates a job with a generated id and defaults enabled=true', () => {
    const res = setJob(root, { schedule: '*/15 * * * *', prompt: 'Do the thing' });
    expect(res.created).toBe(true);
    const jobs = readJobs(root).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'do-the-thing', schedule: '*/15 * * * *', enabled: true, prompt: 'Do the thing' });
  });
  it('updates an existing job in place', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'first' });
    const res = setJob(root, { id: 'a', schedule: '0 * * * *', prompt: 'first', enabled: false });
    expect(res.created).toBe(false);
    const jobs = readJobs(root).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'a', schedule: '0 * * * *', enabled: false });
  });
});

describe('rmJob', () => {
  it('removes and reports found/not-found', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'x' });
    expect(rmJob(root, 'a')).toBe(true);
    expect(rmJob(root, 'a')).toBe(false);
    expect(readJobs(root).jobs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/jobs.test.ts`
Expected: FAIL (cannot resolve `../lib/jobs.mjs`).

- [ ] **Step 3: Write the jobs module**

`plugins/p-shed/tools/lib/jobs.mjs`:
```javascript
import { readJobs, writeJobs } from './io.mjs';
import { parseCron } from './cron.mjs';

export class ValidationError extends Error {}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'job';
}

function uniqueId(base, jobs) {
  let id = base;
  let n = 2;
  const taken = new Set(jobs.map((j) => j.id));
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

export function setJob(root, spec) {
  const data = readJobs(root);
  const existing = spec.id ? data.jobs.find((j) => j.id === spec.id) : undefined;

  if (!existing) {
    if (!spec.schedule) throw new ValidationError('schedule is required');
    if (!spec.prompt) throw new ValidationError('prompt is required');
  }
  const schedule = spec.schedule ?? existing.schedule;
  try { parseCron(schedule); } catch (e) { throw new ValidationError(`invalid cron: ${e.message}`); }

  if (existing) {
    Object.assign(existing, pruneUndefined({
      schedule: spec.schedule,
      prompt: spec.prompt,
      enabled: spec.enabled,
      cwd: spec.cwd,
      timeoutSec: spec.timeoutSec,
      permissionMode: spec.permissionMode,
      allowedTools: spec.allowedTools,
    }));
    writeJobs(root, data);
    return { id: existing.id, created: false };
  }

  const id = spec.id ?? uniqueId(slugify(spec.prompt), data.jobs);
  data.jobs.push(pruneUndefined({
    id,
    schedule,
    enabled: spec.enabled ?? true,
    prompt: spec.prompt,
    cwd: spec.cwd,
    timeoutSec: spec.timeoutSec,
    permissionMode: spec.permissionMode,
    allowedTools: spec.allowedTools,
  }));
  writeJobs(root, data);
  return { id, created: true };
}

export function rmJob(root, id) {
  const data = readJobs(root);
  const before = data.jobs.length;
  data.jobs = data.jobs.filter((j) => j.id !== id);
  if (data.jobs.length === before) return false;
  writeJobs(root, data);
  return true;
}

function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/jobs.mjs plugins/p-shed/tools/__tests__/jobs.test.ts
git commit -m "feat(p-shed): job add/modify/remove with cron validation"
```

---

### Task 6: Logs (append + 7-day rotation)

**Files:**
- Create: `plugins/p-shed/tools/lib/logs.mjs`
- Test: `plugins/p-shed/tools/__tests__/logs.test.ts`

**Interfaces:**
- Consumes: `paths` from `io.mjs`.
- Produces: `appendLog(root, record, nowMs) => void` (appends `JSON.stringify(record)+"\n"` to `logs/<YYYY-MM-DD>.jsonl`, date derived from `nowMs`); `rotateLogs(root, nowMs, retentionDays = 7) => string[]` (deletes `logs/*.jsonl` whose date is older than `retentionDays` before `nowMs`; returns the deleted filenames).

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/logs.test.ts`:
```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, rotateLogs } from '../lib/logs.mjs';
import { paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-logs-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const day = (s: string) => new Date(s + 'T12:00:00').getTime();

describe('appendLog', () => {
  it('writes one JSON line to the dated file', () => {
    appendLog(root, { job: 'a', exit: 0 }, day('2026-07-16'));
    const file = join(paths(root).logsDir, '2026-07-16.jsonl');
    expect(readFileSync(file, 'utf-8')).toBe('{"job":"a","exit":0}\n');
  });
});

describe('rotateLogs', () => {
  it('deletes files older than the retention window', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-01.jsonl'), 'x\n');   // 15 days old
    writeFileSync(join(dir, '2026-07-16.jsonl'), 'x\n');   // today
    const deleted = rotateLogs(root, day('2026-07-16'), 7);
    expect(deleted).toEqual(['2026-07-01.jsonl']);
    expect(existsSync(join(dir, '2026-07-01.jsonl'))).toBe(false);
    expect(existsSync(join(dir, '2026-07-16.jsonl'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/logs.test.ts`
Expected: FAIL (cannot resolve `../lib/logs.mjs`).

- [ ] **Step 3: Write the logs module**

`plugins/p-shed/tools/lib/logs.mjs`:
```javascript
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './io.mjs';

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function appendLog(root, record, nowMs) {
  const dir = paths(root).logsDir;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${dateStr(nowMs)}.jsonl`), JSON.stringify(record) + '\n', 'utf-8');
}

export function rotateLogs(root, nowMs, retentionDays = 7) {
  const dir = paths(root).logsDir;
  if (!existsSync(dir)) return [];
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const deleted = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
      rmSync(join(dir, name), { force: true });
      deleted.push(name);
    }
  }
  return deleted;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/logs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/logs.mjs plugins/p-shed/tools/__tests__/logs.test.ts
git commit -m "feat(p-shed): run logs with 7-day rotation"
```

---

### Task 7: Launch (build args, spawn, timeout, tree-kill)

**Files:**
- Create: `plugins/p-shed/tools/lib/launch.mjs`
- Test: `plugins/p-shed/tools/__tests__/launch.test.ts`

**Interfaces:**
- Produces: `buildArgs(job, defaults) => string[]` (assembles `-p <prompt> --output-format json --permission-mode <mode>` plus `--allowedTools <list>` when set; `<mode>` falls back to `acceptEdits` so an empty `defaults` never yields an `undefined` argv entry); `killTree(pid) => void`; `runJob({ job, defaults, claudeBin, spawnFn?, killFn?, now?, onSpawn? }) => Promise<{ pid, exit, timedOut, durationMs }>` (spawns `claudeBin` with `buildArgs`, in `job.cwd ?? defaults.cwd ?? '.'`; calls `onSpawn(childPid)` **immediately after spawn** — used by `tick` to write the pidfile before the run finishes; on timeout calls `killFn(pid)` and resolves with `timedOut: true, exit: null`).

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/launch.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildArgs, runJob } from '../lib/launch.mjs';

const defaults = { cwd: '.', timeoutSec: 900, permissionMode: 'acceptEdits', allowedTools: 'Read,Write' };

describe('buildArgs', () => {
  it('assembles the claude -p command', () => {
    expect(buildArgs({ prompt: 'go' }, defaults)).toEqual([
      '-p', 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write',
    ]);
  });
  it('per-job overrides win and allowedTools is optional', () => {
    expect(buildArgs({ prompt: 'go', permissionMode: 'plan', allowedTools: '' }, defaults)).toEqual([
      '-p', 'go', '--output-format', 'json', '--permission-mode', 'plan',
    ]);
  });
});

describe('runJob', () => {
  it('resolves with the exit code on normal exit', async () => {
    const child: any = new EventEmitter();
    child.pid = 4242;
    const spawnFn = vi.fn(() => child);
    const p = runJob({ job: { prompt: 'go' }, defaults, claudeBin: 'claude', spawnFn, now: () => 1000 });
    child.emit('exit', 0);
    await expect(p).resolves.toMatchObject({ pid: 4242, exit: 0, timedOut: false });
  });

  it('kills the process tree on timeout', async () => {
    vi.useFakeTimers();
    const child: any = new EventEmitter();
    child.pid = 99;
    const spawnFn = vi.fn(() => child);
    const killFn = vi.fn();
    const p = runJob({ job: { prompt: 'go', timeoutSec: 1 }, defaults, claudeBin: 'claude', spawnFn, killFn, now: () => 0 });
    vi.advanceTimersByTime(1000);
    expect(killFn).toHaveBeenCalledWith(99);
    child.emit('exit', null);           // process dies after the kill
    await expect(p).resolves.toMatchObject({ timedOut: true, exit: null });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/launch.test.ts`
Expected: FAIL (cannot resolve `../lib/launch.mjs`).

- [ ] **Step 3: Write the launch module**

`plugins/p-shed/tools/lib/launch.mjs`:
```javascript
import { spawn } from 'node:child_process';

export function buildArgs(job, defaults) {
  const mode = job.permissionMode ?? defaults.permissionMode ?? 'acceptEdits';
  const allowed = job.allowedTools ?? defaults.allowedTools;
  const args = ['-p', job.prompt, '--output-format', 'json', '--permission-mode', mode];
  if (allowed) args.push('--allowedTools', allowed);
  return args;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}

export function runJob({ job, defaults, claudeBin, spawnFn = spawn, killFn = killTree, now = Date.now, onSpawn }) {
  return new Promise((resolve) => {
    const start = now();
    const args = buildArgs(job, defaults);
    const timeoutSec = job.timeoutSec ?? defaults.timeoutSec ?? 900;
    const isWin = process.platform === 'win32';
    // On Windows `claude` is a `.cmd` shim; Node's spawn can't launch it directly
    // (and must not use shell:true, which mangles a prompt containing spaces).
    // Route through cmd.exe so Node's normal argv quoting still applies to the prompt.
    const file = isWin ? (process.env.ComSpec || 'cmd.exe') : claudeBin;
    const spawnArgs = isWin ? ['/c', claudeBin, ...args] : args;
    const child = spawnFn(file, spawnArgs, {
      cwd: job.cwd ?? defaults.cwd ?? '.',
      detached: !isWin,          // own process group so killFn(-pid) reaps children on POSIX
      stdio: 'ignore',
      windowsHide: true,
    });
    // Publish the pidfile NOW (before awaiting exit) so a concurrent minute-tick sees a
    // live run and skips it. The duplicate guard must hold for the whole run — writing
    // the pidfile only after the run would let overlapping ticks double-launch long jobs.
    if (onSpawn) onSpawn(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killFn(child.pid); }, timeoutSec * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, exit: timedOut ? null : code, timedOut, durationMs: now() - start });
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/launch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/launch.mjs plugins/p-shed/tools/__tests__/launch.test.ts
git commit -m "feat(p-shed): launch claude -p with timeout and process-tree kill"
```

---

### Task 8: Tick orchestration

**Files:**
- Create: `plugins/p-shed/tools/lib/tick.mjs`
- Test: `plugins/p-shed/tools/__tests__/tick.test.ts`

**Interfaces:**
- Consumes: `readJobs`, `readConfig`, `readState`, `writeState`, `paths` (io); `parseCron`, `isDue` (cron); `runJob` (launch); `appendLog`, `rotateLogs` (logs).
- Produces: `isPidAlive(pid) => boolean`; `tick({ root, now?, deps? }) => Promise<Array<{ id, action: 'launched'|'skipped'|'baselined'|'not-due', exit?, timedOut? }>>`. `deps` defaults to the real modules but is injectable for tests: `{ readJobs, readConfig, readState, writeState, runJob, appendLog, rotateLogs, isPidAlive, writePid, removePid }`. Behavior: rotate logs first; for each job — a job with no prior state is **baselined** (record `lastRun = now`, do not launch); a disabled job is skipped silently; a job whose pidfile pid is alive → `skipped`; a due job → launch via `runJob` (which writes the pidfile at spawn via `onSpawn`, so a concurrent minute-tick during a long run skips it), then persist `lastRun/lastExit`, append a log record, remove the pidfile; a job that is enabled but not due → `not-due`.

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/tick.test.ts`:
```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeState, readState } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-tick-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const NOW = new Date(2026, 6, 16, 1, 20).getTime(); // 2026-07-16 01:20 local

function fakeDeps(overrides = {}) {
  return {
    runJob: vi.fn(async () => ({ pid: 123, exit: 0, timedOut: false, durationMs: 5 })),
    appendLog: vi.fn(),
    rotateLogs: vi.fn(),
    isPidAlive: vi.fn(() => false),
    writePid: vi.fn(),
    removePid: vi.fn(),
    ...overrides,
  };
}

describe('tick', () => {
  it('baselines a brand-new job instead of launching it', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'baselined' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(readState(root).jobs.a.lastRun).toBe(NOW);
  });

  it('launches a due job and persists state + log', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeState(root, { jobs: { a: { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: 0, pid: null } } });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
    expect(deps.runJob).toHaveBeenCalledOnce();
    expect(deps.appendLog).toHaveBeenCalledOnce();
    expect(readState(root).jobs.a.lastRun).toBe(NOW);
    expect(readState(root).jobs.a.lastExit).toBe(0);
  });

  it('skips a job whose previous run is still alive', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeState(root, { jobs: { a: { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: null, pid: 777 } } });
    const deps = fakeDeps({ isPidAlive: vi.fn(() => true) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'skipped' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it('reports not-due for an enabled job with no matching minute', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeState(root, { jobs: { a: { lastRun: new Date(2026, 6, 16, 1, 16).getTime(), lastExit: 0, pid: null } } });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'not-due' }]);
  });

  it('rotates logs once per tick', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [] });
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.rotateLogs).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/tick.test.ts`
Expected: FAIL (cannot resolve `../lib/tick.mjs`).

- [ ] **Step 3: Write the tick module**

`plugins/p-shed/tools/lib/tick.mjs`:
```javascript
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJobs, readConfig, readState, writeState } from './io.mjs';
import { parseCron, isDue } from './cron.mjs';
import { runJob as realRunJob } from './launch.mjs';
import { appendLog as realAppendLog, rotateLogs as realRotateLogs } from './logs.mjs';

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function writePid(root, id, pid) {
  const dir = paths(root).runDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.pid`), String(pid), 'utf-8');
}

function removePid(root, id) {
  rmSync(join(paths(root).runDir, `${id}.pid`), { force: true });
}

function readPid(root, id) {
  const p = join(paths(root).runDir, `${id}.pid`);
  if (!existsSync(p)) return null;
  const n = parseInt(readFileSync(p, 'utf-8').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

export async function tick({ root, now = Date.now(), deps = {} }) {
  const d = {
    readJobs, readConfig, readState, writeState,
    runJob: realRunJob, appendLog: realAppendLog, rotateLogs: realRotateLogs,
    isPidAlive, writePid: (id, pid) => writePid(root, id, pid), removePid: (id) => removePid(root, id),
    ...deps,
  };

  d.rotateLogs(root, now);
  const { defaults, jobs } = d.readJobs(root);
  const config = d.readConfig(root);
  const state = d.readState(root);
  const results = [];

  for (const job of jobs) {
    if (job.enabled === false) continue;
    const st = state.jobs[job.id];

    if (!st || st.lastRun == null) {
      state.jobs[job.id] = { lastRun: now, lastExit: null, pid: null };
      results.push({ id: job.id, action: 'baselined' });
      continue;
    }

    const pid = readPid(root, job.id) ?? st.pid;
    if (d.isPidAlive(pid)) { results.push({ id: job.id, action: 'skipped' }); continue; }

    if (!isDue(parseCron(job.schedule), st.lastRun, now)) {
      results.push({ id: job.id, action: 'not-due' });
      continue;
    }

    const r = await d.runJob({ job, defaults, claudeBin: config.claudeBin, onSpawn: (pid) => { if (pid) d.writePid(job.id, pid); } });
    state.jobs[job.id] = { lastRun: now, lastExit: r.exit, pid: null };
    d.appendLog(root, { ts: now, job: job.id, exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs }, now);
    d.removePid(job.id);
    results.push({ id: job.id, action: 'launched', exit: r.exit, timedOut: r.timedOut });
  }

  d.writeState(root, state);
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/tick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/tick.mjs plugins/p-shed/tools/__tests__/tick.test.ts
git commit -m "feat(p-shed): tick orchestration (due calc, duplicate guard, catch-up)"
```

---

### Task 9: OS scheduler install/remove

**Files:**
- Create: `plugins/p-shed/tools/lib/scheduler.mjs`
- Test: `plugins/p-shed/tools/__tests__/scheduler.test.ts`

**Interfaces:**
- Produces: `taskName(root) => string` (stable per-folder id, e.g. `pshed-<8-hex>`); `buildInstall({ platform, root, nodeBin, toolPath }) => { file: string, args: string[] }`; `buildRemove({ platform, root }) => { file: string, args: string[] }` for `win32`; and `crontabLine({ root, nodeBin, toolPath }) => string` + `applyCrontab(existing, line, marker) => string` / `removeFromCrontab(existing, marker) => string` for POSIX (pure string transforms so they are unit-testable without touching the real crontab).

- [ ] **Step 1: Write the failing test**

`plugins/p-shed/tools/__tests__/scheduler.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { taskName, buildInstall, buildRemove, crontabLine, applyCrontab, removeFromCrontab } from '../lib/scheduler.mjs';

const root = '/home/me/work';
const nodeBin = '/usr/bin/node';
const toolPath = '/plugins/p-shed/tools/pshed.mjs';

describe('taskName', () => {
  it('is stable and folder-scoped', () => {
    expect(taskName(root)).toBe(taskName(root));
    expect(taskName(root)).toMatch(/^pshed-[0-9a-f]{8}$/);
    expect(taskName('/other')).not.toBe(taskName(root));
  });
});

describe('windows schtasks', () => {
  it('install creates a per-minute task that cds into root', () => {
    const { file, args } = buildInstall({ platform: 'win32', root, nodeBin, toolPath });
    expect(file).toBe('schtasks');
    expect(args).toContain('/Create');
    expect(args).toContain('/SC'); expect(args).toContain('MINUTE');
    expect(args).toContain('/F');
    expect(args.join(' ')).toContain(taskName(root));
    expect(args.join(' ')).toContain('tick');
  });
  it('remove deletes the task by name', () => {
    const { file, args } = buildRemove({ platform: 'win32', root });
    expect(file).toBe('schtasks');
    expect(args).toContain('/Delete');
    expect(args.join(' ')).toContain(taskName(root));
  });
});

describe('posix crontab transforms', () => {
  const marker = `# ${taskName(root)}`;
  it('crontabLine runs tick every minute in root, tagged with the marker', () => {
    const line = crontabLine({ root, nodeBin, toolPath });
    expect(line).toContain('* * * * *');
    expect(line).toContain(root);
    expect(line).toContain('tick');
    expect(line).toContain(marker);
  });
  it('applyCrontab is idempotent', () => {
    const line = crontabLine({ root, nodeBin, toolPath });
    const once = applyCrontab('', line, marker);
    const twice = applyCrontab(once, line, marker);
    expect(twice).toBe(once);
    expect(once.split('\n').filter((l) => l.includes(marker))).toHaveLength(1);
  });
  it('removeFromCrontab strips only the tagged line', () => {
    const line = crontabLine({ root, nodeBin, toolPath });
    const withUser = applyCrontab('0 5 * * * backup\n', line, marker);
    const removed = removeFromCrontab(withUser, marker);
    expect(removed).toBe('0 5 * * * backup');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/scheduler.test.ts`
Expected: FAIL (cannot resolve `../lib/scheduler.mjs`).

- [ ] **Step 3: Write the scheduler module**

`plugins/p-shed/tools/lib/scheduler.mjs`:
```javascript
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function taskName(root) {
  const hash = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8);
  return `pshed-${hash}`;
}

// Windows: wrap in cmd so we can cd into the folder before running tick.
export function buildInstall({ platform, root, nodeBin, toolPath }) {
  if (platform !== 'win32') throw new Error('buildInstall is win32-only; POSIX uses crontab transforms');
  const tr = `cmd /c cd /d "${resolve(root)}" && "${nodeBin}" "${toolPath}" tick`;
  return { file: 'schtasks', args: ['/Create', '/TN', taskName(root), '/SC', 'MINUTE', '/TR', tr, '/F'] };
}

export function buildRemove({ platform, root }) {
  if (platform !== 'win32') throw new Error('buildRemove is win32-only; POSIX uses crontab transforms');
  return { file: 'schtasks', args: ['/Delete', '/TN', taskName(root), '/F'] };
}

// POSIX crontab: minimal env is handled by absolute paths; cd sets the working dir.
export function crontabLine({ root, nodeBin, toolPath }) {
  const abs = resolve(root);
  return `* * * * * cd "${abs}" && "${nodeBin}" "${toolPath}" tick >> "${abs}/.pshed/logs/cron.log" 2>&1 # ${taskName(root)}`;
}

export function applyCrontab(existing, line, marker) {
  const kept = (existing ? existing.split('\n') : []).filter((l) => l.trim() && !l.includes(marker));
  kept.push(line);
  return kept.join('\n') + '\n';
}

export function removeFromCrontab(existing, marker) {
  return (existing ? existing.split('\n') : []).filter((l) => l.trim() && !l.includes(marker)).join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/scheduler.mjs plugins/p-shed/tools/__tests__/scheduler.test.ts
git commit -m "feat(p-shed): cross-OS scheduler install/remove helpers"
```

---

### Task 10: Wire CLI commands + end-to-end run

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs` (replace the `main()` dispatcher stub)
- Test: `plugins/p-shed/tools/__tests__/cli-e2e.test.ts`

**Interfaces:**
- Consumes: everything from `lib/*`.
- Produces: CLI commands `tick`, `run <id>`, `set-job`, `rm-job`, `install-cron`, `remove-cron`, each emitting JSON and using exit codes `0/1/2`. `run <id>` executes exactly one job immediately via `runJob`, bypassing the schedule, and returns its result.

- [ ] **Step 1: Write the failing e2e test**

`plugins/p-shed/tools/__tests__/cli-e2e.test.ts`:
```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-e2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const runCli = (args: string[], claudeBin?: string) =>
  execFileSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf-8',
    cwd: root,
    env: { ...process.env, ...(claudeBin ? { PSHED_CLAUDE_BIN: claudeBin } : {}) },
  });

describe('cli e2e', () => {
  it('set-job then rm-job persists to jobs.yml', () => {
    const added = JSON.parse(runCli(['set-job', '--schedule', '*/15 * * * *', '--prompt', 'Do it']));
    expect(added.created).toBe(true);
    expect(existsSync(join(root, '.pshed', 'jobs.yml'))).toBe(true);
    const removed = JSON.parse(runCli(['rm-job', '--id', added.id]));
    expect(removed.removed).toBe(true);
  });

  it('set-job with a bad cron exits 2', () => {
    expect(() => runCli(['set-job', '--schedule', 'nope', '--prompt', 'x'])).toThrow(/Command failed/);
  });

  it('run <id> launches the configured claude binary immediately', () => {
    // A fake "claude" that records it was called into a sentinel file.
    const sentinel = join(root, 'called.txt');
    const fake = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude.sh');
    if (process.platform === 'win32') {
      writeFileSync(fake, `@echo done> "${sentinel}"\r\n`);
    } else {
      writeFileSync(fake, `#!/bin/sh\necho done > "${sentinel}"\n`);
      chmodSync(fake, 0o755);
    }
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    // Point config.json at the fake claude.
    writeFileSync(join(root, '.pshed', 'config.json'), JSON.stringify({ nodeBin: 'node', claudeBin: fake }));
    const res = JSON.parse(runCli(['run', 'a']));
    expect(res.result.pid).toBeGreaterThan(0);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf-8')).toContain('done');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-e2e.test.ts`
Expected: FAIL (commands are not implemented — `run`/`set-job` exit with "not implemented yet").

- [ ] **Step 3: Wire the dispatcher**

In `plugins/p-shed/tools/pshed.mjs`, add imports at the top (after the existing imports):
```javascript
import { readJobs, readConfig } from './lib/io.mjs';
import { setJob, rmJob, ValidationError } from './lib/jobs.mjs';
import { tick as runTick } from './lib/tick.mjs';
import { runJob } from './lib/launch.mjs';
import { buildInstall, buildRemove, taskName, crontabLine, applyCrontab, removeFromCrontab } from './lib/scheduler.mjs';
import { execFileSync } from 'node:child_process';
```

Replace the whole `main()` function body with:
```javascript
async function main() {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  const root = findRoot(process.cwd());

  try {
    if (command === 'tick') {
      const results = await runTick({ root, now: Date.now() });
      return emitJson({ results }, 0);
    }

    if (command === 'run') {
      const id = args._[0];
      if (!id) return emitJson({ error: { code: 'validation', message: 'run <id> requires a job id' } }, 2);
      const { defaults, jobs } = readJobs(root);
      const job = jobs.find((j) => j.id === id);
      if (!job) return emitJson({ error: { code: 'validation', message: `no such job: ${id}` } }, 2);
      const config = readConfig(root);
      const result = await runJob({ job, defaults, claudeBin: config.claudeBin });
      return emitJson({ id, result }, 0);
    }

    if (command === 'set-job') {
      const res = setJob(root, {
        id: args.id, schedule: args.schedule, prompt: args.prompt,
        enabled: args.enabled === undefined ? undefined : args.enabled !== 'false' && args.enabled !== false,
        cwd: args.cwd, timeoutSec: args.timeoutSec ? Number(args.timeoutSec) : undefined,
        permissionMode: args['permission-mode'], allowedTools: args['allowed-tools'],
      });
      return emitJson(res, 0);
    }

    if (command === 'rm-job') {
      if (!args.id) return emitJson({ error: { code: 'validation', message: 'rm-job requires --id' } }, 2);
      return emitJson({ id: args.id, removed: rmJob(root, args.id) }, 0);
    }

    if (command === 'install-cron' || command === 'remove-cron') {
      return emitJson(manageCron(command, root), 0);
    }
  } catch (e) {
    if (e instanceof ValidationError) return emitJson({ error: { code: 'validation', message: e.message } }, 2);
    return emitJson({ error: { code: 'internal', message: e?.message ?? String(e) } }, 1);
  }
}

function manageCron(command, root) {
  const nodeBin = process.execPath;
  const toolPath = fileURLToPath(import.meta.url);
  if (process.platform === 'win32') {
    const { file, args } = command === 'install-cron'
      ? buildInstall({ platform: 'win32', root, nodeBin, toolPath })
      : buildRemove({ platform: 'win32', root });
    execFileSync(file, args, { stdio: 'ignore' });
    return { scheduler: 'schtasks', task: taskName(root), action: command };
  }
  // POSIX crontab
  const marker = `# ${taskName(root)}`;
  let existing = '';
  try { existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8' }); } catch { existing = ''; }
  const next = command === 'install-cron'
    ? applyCrontab(existing, crontabLine({ root, nodeBin, toolPath }), marker)
    : removeFromCrontab(existing, marker) + '\n';
  execFileSync('crontab', ['-'], { input: next });
  return { scheduler: 'crontab', task: taskName(root), action: command };
}
```

- [ ] **Step 4: Run the e2e test**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-e2e.test.ts`
Expected: PASS. (The `install-cron`/`remove-cron` real paths are covered indirectly by Task 9's pure transforms; the e2e test does not touch the real OS scheduler.)

- [ ] **Step 5: Run the full tool suite**

Run: `npx vitest run plugins/p-shed/`
Expected: PASS (all tool tests green).

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-e2e.test.ts
git commit -m "feat(p-shed): wire tick/run/set-job/rm-job/install-cron/remove-cron"
```

---

### Task 11: Skills + finalize README/CLAUDE.md

**Files:**
- Create: `plugins/p-shed/skills/init/SKILL.md`
- Create: `plugins/p-shed/skills/start/SKILL.md`
- Create: `plugins/p-shed/skills/stop/SKILL.md`
- Create: `plugins/p-shed/skills/job/SKILL.md`
- Modify: `plugins/p-shed/README.md` (fill Commands + Formats)
- Test: `plugins/p-shed/tools/__tests__/skills-structure.test.ts`

**Interfaces:**
- Consumes: the CLI commands from Task 10.
- Produces: four skills whose frontmatter satisfies `tests/skills.test.ts` (name matches dir, description ≥ 30 chars, parseable `allowed-tools`) and whose names are referenced in the README (`tests/plugin-readme-coverage.test.ts`).

- [ ] **Step 1: Write the `init` skill**

`plugins/p-shed/skills/init/SKILL.md`:
```markdown
---
name: init
description: Scaffold p-shed in the current folder — create `.pshed/` (jobs, state, logs, run) and gitignore the volatile parts. Use when the user says "init p-shed", "set up the scheduler", or "start scheduling Claude runs here".
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(node:*) Bash(mkdir:*) Bash(which:*) Bash(where:*) Read Write Edit
---

# /p-shed:init

Scaffold the `p-shed` scheduler in the current folder. One-shot.

## Step 0 — Verify Node 18+
Run `node --version`. If it fails or the major version is < 18, stop and tell the user to install/update Node.

## Step 1 — Refuse if already initialized
If `.pshed/` exists, stop and tell the user: "p-shed already initialized here. Edit `.pshed/jobs.yml` to change jobs, or remove `.pshed/` to reset." Do not proceed.

## Step 2 — Resolve the folder
Use the current working directory as the p-shed home. (Jobs run relative to their own `cwd`; this folder just holds the scheduler state.)

## Step 3 — Create the layout
Create `.pshed/`, `.pshed/logs/`, `.pshed/run/`.

Write `.pshed/jobs.yml` (tracked in git):
    version: 1
    defaults:
      cwd: "."
      timeoutSec: 900
      permissionMode: acceptEdits
      allowedTools: "Read,Write,Edit,Bash(git *)"
    jobs: []

Write `.pshed/state.json` (gitignored):
    { "jobs": {} }

Resolve the binaries and write `.pshed/config.json` (gitignored). Resolve `claude`'s
absolute path (`which claude` on POSIX, `where claude` on Windows); if it cannot be
resolved, write `"claude"` and warn the user that `p-shed:start` needs `claude` on PATH.
    { "nodeBin": "<absolute node path or 'node'>", "claudeBin": "<absolute claude path or 'claude'>" }

## Step 4 — gitignore the volatile parts
Ensure these lines exist in `<folder>/.gitignore` (append if missing). Keep `jobs.yml` tracked.
    .pshed/config.json
    .pshed/state.json
    .pshed/logs/
    .pshed/run/

## Step 5 — Report
Tell the user what was created and that the next steps are `/p-shed:job` to add a schedule and `/p-shed:start` to begin ticking. Note: no rule file is installed — put run instructions in each job's prompt.
```

- [ ] **Step 2: Write the `start` skill**

`plugins/p-shed/skills/start/SKILL.md`:
```markdown
---
name: start
description: Install the OS scheduler entry that runs `pshed tick` every minute in this folder (Windows schtasks, Linux/macOS crontab). Use when the user says "start p-shed", "enable the scheduler", or "begin running jobs".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read
---

# /p-shed:start

## Step 1 — Require initialization
If `.pshed/` does not exist in the current folder, stop and say: "Run `/p-shed:init` first." Do NOT auto-scaffold.

## Step 2 — Install the scheduler entry
Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" install-cron --json
Report the printed JSON (`scheduler`, `task`, `action`). This registers `pshed tick` to run every minute in this folder; it is idempotent.

## Step 3 — Report
Tell the user the scheduler is active and that `/p-shed:stop` removes it.
```

- [ ] **Step 3: Write the `stop` skill**

`plugins/p-shed/skills/stop/SKILL.md`:
```markdown
---
name: stop
description: Remove the OS scheduler entry that runs `pshed tick` for this folder. Use when the user says "stop p-shed", "disable the scheduler", or "pause the jobs".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read
---

# /p-shed:stop

## Step 1 — Remove the scheduler entry
Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" remove-cron --json
Report the printed JSON. This is idempotent — removing an absent entry is fine.
```

- [ ] **Step 4: Write the `job` skill**

`plugins/p-shed/skills/job/SKILL.md`:
```markdown
---
name: job
description: Add, modify, or delete a scheduled job in `.pshed/jobs.yml` (cron schedule + folder + prompt). Use when the user says "add a job", "schedule a run", "change the schedule", "disable a job", or "delete a job".
argument-hint: --schedule <cron> --prompt <text> [--id <id>]
allowed-tools: Bash(node:*) Read
---

# /p-shed:job

Manage one scheduled job. A job is a timer: **when** (cron), **where** (`cwd`), **what** (`prompt`).

## Add or modify
Collect: cron `schedule` (validate the 5-field form), the `prompt`, optional `cwd`
(defaults to `.`), optional `timeoutSec`/`permissionMode`/`allowedTools`. To modify an
existing job, pass its `--id`. Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" set-job --schedule "<cron>" --prompt "<text>" [--id <id>] [--cwd <path>] [--timeoutSec <n>] [--permission-mode <mode>] [--allowed-tools "<list>"] --json
On exit code 2 (`error.code = validation`), show the message (e.g. bad cron) and ask again.

## Delete
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" rm-job --id <id> --json
Report whether it was removed.

## Report
Echo the resulting job id and that changes take effect on the next tick.
```

- [ ] **Step 5: Fill in the README Commands + Formats sections**

Replace the two placeholder sections in `plugins/p-shed/README.md`:
```markdown
## Commands

Tool: `node tools/pshed.mjs <command>` (all support `--json`; exit `0` ok / `1` env / `2` validation):

| Command | Purpose |
|---|---|
| `tick` | Cron entry point — run every due job once. Invoked by the OS scheduler each minute. |
| `run <id>` | Run one job immediately, bypassing the schedule (manual/testing). |
| `set-job` | Add or modify a job (`--schedule`, `--prompt`, `--id`, `--cwd`, `--timeoutSec`, `--permission-mode`, `--allowed-tools`). |
| `rm-job` | Delete a job (`--id`). |
| `install-cron` / `remove-cron` | Register/unregister the every-minute `tick` in the OS scheduler for this folder. |

## Formats

`.pshed/` layout:

| File | Tracked? | Contents |
|---|---|---|
| `jobs.yml` | git | `version`, `defaults`, `jobs[]{ id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools? }` |
| `config.json` | gitignore | `{ nodeBin, claudeBin }` (resolved at init) |
| `state.json` | gitignore | per-job `{ lastRun, lastExit, pid }` |
| `logs/<date>.jsonl` | gitignore | one record per run; auto-rotated (7-day retention) |
| `run/<id>.pid` | gitignore | duplicate-guard pidfile |

Example `jobs.yml`:

    version: 1
    defaults:
      cwd: "."
      timeoutSec: 900
      permissionMode: acceptEdits
      allowedTools: "Read,Write,Edit,Bash(git *)"
    jobs:
      - id: task-runner
        schedule: "*/15 * * * *"
        enabled: true
        prompt: "Take the next unblocked work item in this repo and complete it."
```

- [ ] **Step 6: Write the skills-structure test**

`plugins/p-shed/tools/__tests__/skills-structure.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(process.cwd(), 'plugins/p-shed/skills');
const read = (name: string) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf-8');

describe('p-shed skills', () => {
  it('ships exactly init, start, stop, job', () => {
    for (const s of ['init', 'start', 'stop', 'job']) {
      expect(existsSync(join(skillsDir, s, 'SKILL.md'))).toBe(true);
    }
  });
  it('init scaffolds the required files and gitignores volatile ones, without writing a rule', () => {
    const init = read('init');
    for (const token of ['.pshed/jobs.yml', '.pshed/state.json', '.pshed/logs/', '.pshed/run/', '.gitignore']) {
      expect(init).toContain(token);
    }
    expect(init.toLowerCase()).not.toContain('.claude/rules');
  });
  it('start refuses when not initialized (no auto-scaffold)', () => {
    expect(read('start')).toMatch(/p-shed:init/);
  });
  it('start/stop/job invoke the CLI, not a scaffold command', () => {
    expect(read('start')).toContain('install-cron');
    expect(read('stop')).toContain('remove-cron');
    expect(read('job')).toContain('set-job');
    expect(read('job')).toContain('rm-job');
  });
});
```

- [ ] **Step 7: Run the structure test + repo-wide skill/readme tests**

Run: `npx vitest run plugins/p-shed/tools/__tests__/skills-structure.test.ts tests/skills.test.ts tests/plugin-readme-coverage.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/p-shed/skills plugins/p-shed/README.md plugins/p-shed/tools/__tests__/skills-structure.test.ts
git commit -m "feat(p-shed): init/start/stop/job skills and finalized docs"
```

---

### Task 12: Full suite + final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — all p-shed tests plus every pre-existing test (including all p-flow tests) green. If any p-flow test changed state, that is a regression: stop and investigate (p-flow must be untouched).

- [ ] **Step 2: Confirm p-flow is untouched**

Run: `git diff --name-only main -- plugins/p-flow`
Expected: empty output (no p-flow files changed on this branch).

- [ ] **Step 3: Manual smoke test (real scheduler-free)**

Run (in a scratch git repo):
```bash
node plugins/p-shed/tools/pshed.mjs set-job --schedule "* * * * *" --prompt "echo hi" --id smoke --json
node plugins/p-shed/tools/pshed.mjs tick --json
```
Expected: first call prints `{"id":"smoke","created":true}`; `tick` prints a `results` array showing `smoke` `baselined` on the first tick (a second immediate `tick` shows `launched` or `not-due` depending on the minute).

- [ ] **Step 4: Commit any final fixes** (only if Steps 1–3 surfaced issues).

---

## Self-review notes

- **Spec coverage:** scheduler/launcher (Tasks 2,7,8,10); cron + catch-up (Task 4); timeout + tree-kill (Task 7); duplicate guard (Tasks 8,10); catch-up single run (Tasks 4,8); log rotation (Task 6); cross-OS install/remove (Tasks 9,10); skills init/start/stop/job with start-before-init guard (Task 11); formats (Tasks 3,11); no task store / no rule (enforced by Task 11 structure test); p-flow untouched (Task 12). All spec sections map to a task.
- **Deviations from the original brief, all decided during brainstorming:** no dual-mode/shared component; no `worklist.yml`; no rule file; `p-shed:add` renamed `p-shed:job`; built-in cron matcher instead of `cron-parser`; `config.json` holds only machine binaries (defaults live in `jobs.yml`).
