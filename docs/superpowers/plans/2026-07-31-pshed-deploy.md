# p-shed `deploy` / `wait-idle` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give p-shed two operator commands — `wait-idle` (block until no job is running) and `deploy` (wait for idle, pause, run a command, always release) — so changing a repo a live loop is driving stops being hand-rolled.

**Architecture:** Two new pure-logic modules (`lib/idle.mjs` for "who is holding this scope", `lib/deploy.mjs` for the orchestration) plus a small ownership module (`lib/owner.mjs`) that records the deploying process in `.pshed/run/DEPLOY` and lets `tick` reclaim a pause abandoned by a dead deploy. Pause markers gain a third origin, `deploy`, so a reclaim can never lift a halt a human set on purpose. Every module takes injectable `isAlive` / `readPid` / `sleep` / `now` / `spawn`, matching `terminateJobs`, so waits are tested without real processes or real time.

**Tech Stack:** Node ESM (no build step), vitest + TypeScript test files, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-pshed-deploy-design.md`

## Global Constraints

- **No new dependencies.** Plugins ship as a plain file copy with no `npm install`; anything external must be vendored via `scripts/vendor-deps.mjs`. This feature needs nothing new.
- **Both platforms.** Code runs on POSIX and win32. Measured: on Windows a Node process receives neither SIGTERM nor SIGINT, so signal traps are POSIX-only and every signal test is skipped on win32.
- **`shell: process.platform === 'win32'`** when spawning the deployed command. Measured: `spawn('npm', ['--version'])` is ENOENT on Windows without it; POSIX stays shell-less so arguments are not re-interpreted.
- **Pause-marker invariants (CLAUDE.md, load-bearing):** presence pauses — never truthiness of contents, so a bare `touch` keeps working; the reason stays plain text, never a machine blob.
- **Never widen a blast radius on a typo.** An unrecognised target exits 2 and pauses nothing.
- **Do not bump `plugin.json#version` or tag a release** as part of this plan. Releases happen only when the repo owner explicitly asks.
- **Commit messages:** conventional commits, English, no tooling attribution of any kind.
- Run the whole suite with `npx vitest run plugins/p-shed` — baseline before any change is **26 files, 309 tests, all green**.

---

### Task 1: `--` terminator in the shared argument parser

`deploy` must pass a command that carries its own flags. Measured today: `parseArgs(['--reason','fix','--','git','commit','-m','x'])` returns `{_:['commit','-m','x'],reason:'fix','':'git'}` — the bare `--` is treated as a flag with an empty name and swallows `git` as its value.

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs:34-58` (`parseArgs`)
- Test: `plugins/p-shed/tools/__tests__/cli-entry.test.ts`

**Interfaces:**
- Produces: `parseArgs(argv)` gains key `'--'` — a `string[]` of every argument after the first bare `--`, present only when a `--` appeared. All existing keys are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('parseArgs', ...)` block in `plugins/p-shed/tools/__tests__/cli-entry.test.ts`:

```typescript
  it('stops at a bare -- and returns the remainder verbatim', () => {
    expect(parseArgs(['--reason', 'fix', '--', 'git', 'commit', '-m', 'x'])).toEqual({
      _: [], reason: 'fix', '--': ['git', 'commit', '-m', 'x'],
    });
  });
  it('keeps flags after -- out of the parse (they belong to the command)', () => {
    expect(parseArgs(['--', 'npm', 'run', '--silent', 'build'])).toEqual({
      _: [], '--': ['npm', 'run', '--silent', 'build'],
    });
  });
  it('omits the -- key entirely when no terminator is present', () => {
    expect(parseArgs(['status', '--human'])).toEqual({ _: ['status'], human: true });
  });
  it('treats a trailing -- as an empty command list', () => {
    expect(parseArgs(['--reason', 'fix', '--'])).toEqual({ _: [], reason: 'fix', '--': [] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-entry.test.ts`
Expected: FAIL — the first test reports `{_: ['commit','-m','x'], reason:'fix', '': 'git'}` instead of the expected object.

- [ ] **Step 3: Implement the terminator**

In `plugins/p-shed/tools/pshed.mjs`, replace the body of the `for` loop's first branch. The full function becomes:

```javascript
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A bare `--` ends option parsing: everything after it belongs to a command this
    // CLI merely forwards (`deploy -- git commit -m "..."`). Without this, `--` parses
    // as a flag with an empty name and eats the command's first word as its value.
    if (a === '--') {
      out['--'] = argv.slice(i + 1);
      break;
    }
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-entry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suite — no existing command's parse may change**

Run: `npx vitest run plugins/p-shed`
Expected: 26 files, 313 tests, all green.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-entry.test.ts
git commit -m "feat(p-shed): stop argument parsing at a bare --

deploy forwards a command that carries its own flags. Without a terminator,
`--` parsed as a flag with an empty name and swallowed the command's first
word as its value."
```

---

### Task 2: `deploy` as a third pause-marker origin

A pause placed by a deploy must be distinguishable from one a human placed, or the reclaim in Task 4 would lift a deliberate halt. Measured today: `#pshed origin=deploy` reads back as `operator` (the regex matches `[a-z]+`, the code collapses every non-`self` value), and `resetBreaker`'s delete condition is `origin !== 'operator'` — so a third origin would fall into the delete branch.

**Files:**
- Modify: `plugins/p-shed/tools/lib/breaker.mjs:24-95`
- Test: `plugins/p-shed/tools/__tests__/pause.test.ts`

**Interfaces:**
- Produces: `readPauseRecord(root, id)` returns `origin: 'self' | 'operator' | 'deploy'`; `writePause(root, id, { reason, origin })` accepts `origin: 'deploy'` and writes the header `#pshed origin=deploy`; `resetBreaker` keeps any marker whose origin is not `self` and reports `deployPause: true` for a deploy-held one. `DEPLOY_ORIGIN_LINE` is exported alongside `OPERATOR_ORIGIN_LINE`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/p-shed/tools/__tests__/pause.test.ts`:

```typescript
describe('deploy origin', () => {
  it('writePause with origin deploy writes the deploy header and a plain reason', () => {
    writePause(root, 'w', { reason: 'prompt update', origin: 'deploy' });
    expect(readFileSync(pausePath(root, 'w'), 'utf-8')).toBe('#pshed origin=deploy\nprompt update\n');
    expect(readPauseRecord(root, 'w')).toEqual({ origin: 'deploy', reason: 'prompt update' });
  });

  it('readPause returns only the human reason, never the header', () => {
    writePause(root, 'w', { reason: 'prompt update', origin: 'deploy' });
    expect(readPause(root, 'w')).toBe('prompt update');
  });

  it('reset-breaker keeps a deploy pause and says who holds it', () => {
    writePause(root, 'w', { reason: 'prompt update', origin: 'deploy' });
    const res = resetBreaker(root, 'w');
    expect(res.pauseCleared).toBe(false);
    expect(res.deployPause).toBe(true);
    expect(existsSync(pausePath(root, 'w'))).toBe(true);
  });

  it('reset-breaker still clears a self pause and still keeps an operator pause', () => {
    writePause(root, 'selfy', { reason: 'verify went red', origin: 'self' });
    writePause(root, 'oper', { reason: 'by hand', origin: 'operator' });
    expect(resetBreaker(root, 'selfy').pauseCleared).toBe(true);
    expect(existsSync(pausePath(root, 'selfy'))).toBe(false);
    const oper = resetBreaker(root, 'oper');
    expect(oper.operatorPause).toBe(true);
    expect(existsSync(pausePath(root, 'oper'))).toBe(true);
  });

  it('an unrecognised header origin still reads as operator (safe direction)', () => {
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'w'), '#pshed origin=martian\nfrom mars\n', 'utf-8');
    expect(readPauseRecord(root, 'w')).toEqual({ origin: 'operator', reason: 'from mars' });
  });

  it('an empty marker still pauses (presence, not contents)', () => {
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'w'), '', 'utf-8');
    expect(readPause(root, 'w')).toBe('');
    expect(readPauseRecord(root, 'w')).toEqual({ origin: 'self', reason: '' });
  });
});
```

Make sure the file's import line covers everything used above — at the top of `pause.test.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pausePath, readPause, readPauseRecord, writePause, resetBreaker } from '../lib/breaker.mjs';
import { paths } from '../lib/io.mjs';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/pause.test.ts`
Expected: FAIL — the first test gets `origin: 'operator'`; the reset-breaker test finds the marker deleted.

- [ ] **Step 3: Implement the third origin**

In `plugins/p-shed/tools/lib/breaker.mjs`, replace lines 24-25 (the constants), the tail of `readPauseRecord`, the body of `writePause`, and the verdict in `resetBreaker`:

```javascript
const ORIGIN_HEADER = /^#pshed origin=([a-z]+)$/;
export const OPERATOR_ORIGIN_LINE = '#pshed origin=operator';
export const DEPLOY_ORIGIN_LINE = '#pshed origin=deploy';

// Three origins now. `deploy` exists so the tick's orphan reclaim can lift a pause a
// dead `pshed deploy` abandoned WITHOUT touching one a human set deliberately — if the
// two were indistinguishable, the reclaim would silence the whole loop on its own, the
// exact failure the deploy dance was written to prevent. The pid deliberately does NOT
// go in this header: `#pshed origin=deploy pid=123` fails the regex, reads back as a
// self-pause, and reset-breaker on an unrelated job then deletes a live deploy's pause.
// The owner lives in run/DEPLOY instead (lib/owner.mjs).
const KNOWN_ORIGINS = new Set(['self', 'operator', 'deploy']);
```

Then in `readPauseRecord`, replace the final return:

```javascript
  const body = nl === -1 ? '' : raw.slice(nl + 1);
  // An unrecognised header value still reads as `operator`: only p-shed writes headers,
  // and refusing to auto-clear a marker we don't fully understand is the safe direction.
  const origin = KNOWN_ORIGINS.has(m[1]) ? m[1] : 'operator';
  return { origin, reason: body.replace(/\r?\n$/, '') };
```

Then `writePause` — generalised over the origin, byte-identical output for the two existing ones:

```javascript
export function writePause(root, id, { reason, origin = 'operator' } = {}) {
  const existing = readPauseRecord(root, id);
  if (existing) return { id, paused: true, alreadyPaused: true, origin: existing.origin, reason: existing.reason };
  const text = typeof reason === 'string' && reason.trim() !== ''
    ? reason
    : (origin === 'self' ? '' : `paused by ${origin}`);
  mkdirSync(paths(root).runDir, { recursive: true });
  const body = origin === 'self' ? `${text}\n` : `#pshed origin=${origin}\n${text}\n`;
  writeFileSync(pausePath(root, id), body, 'utf-8');
  return { id, paused: true, alreadyPaused: false, origin, reason: text };
}
```

Then `resetBreaker`'s verdict — the delete condition flips from "not operator" to "only self":

```javascript
  const pause = readPauseRecord(root, id);
  // Only a SELF pause is cleared here. Both an operator pause and a deploy-held one are
  // someone else's to lift: the human via `resume`, the deploy via its own release (or
  // the tick's reclaim once its owner is gone).
  const keep = pause != null && pause.origin !== 'self';
  if (pause && !keep) removePause(root, id);
  const held = keep
    ? (pause.origin === 'deploy'
        ? { deployPause: true, pauseReason: pause.reason, hint: `a running deploy holds this pause; it lifts when the deploy finishes, or the next tick reclaims it if the deploy died` }
        : { operatorPause: true, pauseReason: pause.reason, hint: `operator pause kept; lift it with: pshed resume --id ${id}` })
    : {};
  return { id, cleared: true, pauseCleared: pause != null && !keep, ...held };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/pause.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite — the operator path must be byte-identical**

Run: `npx vitest run plugins/p-shed`
Expected: all green. `cli-pause-e2e.test.ts`'s "reset-breaker respects the marker origin" and "a bare touch still pauses" are the two that would catch a regression here.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/lib/breaker.mjs plugins/p-shed/tools/__tests__/pause.test.ts
git commit -m "feat(p-shed): add deploy as a third pause-marker origin

A pause a deploy placed must be distinguishable from one a human placed:
the tick's orphan reclaim lifts the first and must never touch the second.
reset-breaker's delete condition flips from 'not operator' to 'only self',
so the new origin cannot fall into the delete branch."
```

---

### Task 3: `lib/owner.mjs` — record the deploying process, reclaim what it abandoned

**Files:**
- Create: `plugins/p-shed/tools/lib/owner.mjs`
- Modify: `plugins/p-shed/tools/lib/breaker.mjs` (add `listPauseIds`)
- Test: `plugins/p-shed/tools/__tests__/owner.test.ts`

**Interfaces:**
- Consumes: `readPauseRecord`, `removePause`, `writePause` (Task 2).
- Produces:
  - `deployOwnerPath(root): string` → `<root>/.pshed/run/DEPLOY`
  - `readDeployOwner(root): {pid, scope, group, reason, createdAt} | null`
  - `writeDeployOwner(root, {pid, scope, group, reason, now}): object`
  - `removeDeployOwner(root): void`
  - `reclaimOrphanedDeployPauses(root, {isAlive}): {reclaimed: Array<{scope:'global'} | {scope:'job', id:string}>}`
  - `listPauseIds(root): string[]` (from `breaker.mjs`)

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-shed/tools/__tests__/owner.test.ts`:

```typescript
// run/DEPLOY records which process is holding a deploy pause, so a pause abandoned by a
// SIGKILLed / rebooted deploy is reclaimed by the next tick instead of silencing the
// loop forever. On Windows this is the ONLY recovery path: measured, a Node process
// there receives neither SIGTERM nor SIGINT, so a signal trap cannot be the mechanism.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deployOwnerPath, readDeployOwner, writeDeployOwner, removeDeployOwner,
  reclaimOrphanedDeployPauses,
} from '../lib/owner.mjs';
import { writePause, readPauseRecord, pausePath, listPauseIds } from '../lib/breaker.mjs';
import { writeGlobalPause, readGlobalPause, globalPausePath } from '../lib/pause.mjs';
import { paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-owner-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const dead = () => false;
const alive = () => true;

describe('run/DEPLOY', () => {
  it('is at run/DEPLOY and round-trips', () => {
    expect(deployOwnerPath(root)).toBe(join(root, '.pshed', 'run', 'DEPLOY'));
    writeDeployOwner(root, { pid: 4242, scope: 'global', reason: 'prompt update', now: 111 });
    expect(readDeployOwner(root)).toEqual({ pid: 4242, scope: 'global', group: null, reason: 'prompt update', createdAt: 111 });
  });

  it('reads as absent when missing or corrupt', () => {
    expect(readDeployOwner(root)).toBeNull();
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(deployOwnerPath(root), '{not json', 'utf-8');
    expect(readDeployOwner(root)).toBeNull();
  });

  it('removeDeployOwner is idempotent', () => {
    writeDeployOwner(root, { pid: 1, scope: 'global', now: 1 });
    removeDeployOwner(root);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
    expect(() => removeDeployOwner(root)).not.toThrow();
  });

  it('is not a job pidfile — listPidEntries must not see it', async () => {
    const { listPidEntries } = await import('../lib/pids.mjs');
    writeDeployOwner(root, { pid: 1, scope: 'global', now: 1 });
    expect(listPidEntries(root)).toEqual([]);
  });
});

describe('listPauseIds', () => {
  it('lists every <id>.pause and ignores other run files', () => {
    writePause(root, 'a', { reason: 'x', origin: 'operator' });
    writePause(root, 'b', { reason: 'y', origin: 'deploy' });
    writeGlobalPause(root, { reason: 'z' });
    writeDeployOwner(root, { pid: 1, scope: 'global', now: 1 });
    expect(listPauseIds(root).sort()).toEqual(['a', 'b']);
  });
  it('returns [] when the run dir does not exist', () => {
    expect(listPauseIds(root)).toEqual([]);
  });
});

describe('reclaimOrphanedDeployPauses', () => {
  it('lifts a global deploy pause whose owner is dead', () => {
    writeDeployOwner(root, { pid: 999001, scope: 'global', reason: 'prompt update', now: 1 });
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed).toEqual([{ scope: 'global' }]);
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('lifts per-job deploy pauses whose owner is dead', () => {
    writeDeployOwner(root, { pid: 999001, scope: 'group', group: 'hft', now: 1 });
    writePause(root, 'worker', { reason: 'prompt update', origin: 'deploy' });
    writePause(root, 'chat', { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed.sort((a, b) => String((a as any).id).localeCompare(String((b as any).id))))
      .toEqual([{ scope: 'job', id: 'chat' }, { scope: 'job', id: 'worker' }]);
    expect(existsSync(pausePath(root, 'worker'))).toBe(false);
    expect(existsSync(pausePath(root, 'chat'))).toBe(false);
  });

  it('leaves everything alone while the owner is alive', () => {
    writeDeployOwner(root, { pid: process.pid, scope: 'global', now: 1 });
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    writePause(root, 'worker', { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: alive });
    expect(res.reclaimed).toEqual([]);
    expect(readGlobalPause(root)).not.toBeNull();
    expect(existsSync(pausePath(root, 'worker'))).toBe(true);
  });

  it('NEVER lifts an operator pause, even with a dead owner recorded', () => {
    writeDeployOwner(root, { pid: 999001, scope: 'global', now: 1 });
    writeGlobalPause(root, { reason: 'halted by hand' });          // no origin -> operator
    writePause(root, 'worker', { reason: 'by hand', origin: 'operator' });
    writePause(root, 'selfy', { reason: 'verify went red', origin: 'self' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed).toEqual([]);
    expect(readGlobalPause(root)).not.toBeNull();
    expect(readPauseRecord(root, 'worker')).toEqual({ origin: 'operator', reason: 'by hand' });
    expect(readPauseRecord(root, 'selfy')).toEqual({ origin: 'self', reason: 'verify went red' });
  });

  it('treats a deploy pause with no run/DEPLOY at all as an orphan', () => {
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    writePause(root, 'worker', { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: alive });
    expect(res.reclaimed.length).toBe(2);
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(pausePath(root, 'worker'))).toBe(false);
  });

  it('is a no-op with nothing paused and no owner', () => {
    expect(reclaimOrphanedDeployPauses(root, { isAlive: dead })).toEqual({ reclaimed: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/owner.test.ts`
Expected: FAIL — `Cannot find module '../lib/owner.mjs'`.

- [ ] **Step 3: Add `listPauseIds` to `breaker.mjs`**

Append to `plugins/p-shed/tools/lib/breaker.mjs` (and add `readdirSync` to its `node:fs` import):

```javascript
// Every job id with a pause marker on disk, stale ones included. Symmetric with
// listPidEntries() in pids.mjs and deliberately independent of jobs.yml: a job deleted
// from jobs.yml can still have left a marker behind, and the reclaim must find it.
export function listPauseIds(root) {
  const dir = paths(root).runDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(.+)\.pause$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1]);
}
```

- [ ] **Step 4: Create `lib/owner.mjs`**

```javascript
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './io.mjs';
import { isPidAlive } from './pids.mjs';
import { listPauseIds, readPauseRecord, removePause } from './breaker.mjs';
import { readGlobalPause, removeGlobalPause } from './pause.mjs';

// Who is currently holding a deploy pause. A signal trap cannot be the recovery
// mechanism — measured, a Node process on Windows receives neither SIGTERM nor SIGINT,
// and SIGKILL / a reboot / a power cut defeat a trap on every platform. So the owner is
// recorded on disk and the tick reclaims what a dead owner abandoned.
//
// This file is `DEPLOY`, not `<something>.pid`: the only reader of run/ is
// listPidEntries(), whose regex is /^(.+)\.pid$/, so this can never become a phantom job
// in `status` or in `stop --kill`'s teardown — the trap CLAUDE.md records against a
// run/<group>.pid file.
export function deployOwnerPath(root) {
  return join(paths(root).runDir, 'DEPLOY');
}

export function readDeployOwner(root) {
  const p = deployOwnerPath(root);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, 'utf-8'));
    return typeof o?.pid === 'number' ? o : null;
  } catch {
    return null; // corrupt (e.g. killed mid-write) -> no owner, so its pauses are orphans
  }
}

// Written BEFORE any pause is placed, so the "marker exists, owner unknown" window
// cannot open. The reverse window (owner recorded, nothing paused yet) is harmless:
// there is nothing to reclaim.
export function writeDeployOwner(root, { pid, scope, group = null, reason = null, now = Date.now() } = {}) {
  const state = { pid, scope, group, reason, createdAt: now };
  mkdirSync(paths(root).runDir, { recursive: true });
  writeFileSync(deployOwnerPath(root), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  return state;
}

export function removeDeployOwner(root) {
  rmSync(deployOwnerPath(root), { force: true });
}

// A deploy-origin marker is an orphan when run/DEPLOY is absent or its pid is not alive.
// ONLY deploy-origin markers are touched: an operator pause is a halt a human set on
// purpose, and lifting it here would silence the loop exactly the way trap 1 did.
export function reclaimOrphanedDeployPauses(root, { isAlive = isPidAlive } = {}) {
  const owner = readDeployOwner(root);
  if (owner && isAlive(owner.pid)) return { reclaimed: [] };

  const reclaimed = [];
  if (readGlobalPause(root)?.origin === 'deploy') {
    removeGlobalPause(root);
    reclaimed.push({ scope: 'global' });
  }
  for (const id of listPauseIds(root)) {
    if (readPauseRecord(root, id)?.origin !== 'deploy') continue;
    removePause(root, id);
    reclaimed.push({ scope: 'job', id });
  }
  if (owner) removeDeployOwner(root);
  return { reclaimed };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/owner.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run plugins/p-shed`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-shed/tools/lib/owner.mjs plugins/p-shed/tools/lib/breaker.mjs plugins/p-shed/tools/__tests__/owner.test.ts
git commit -m "feat(p-shed): record the deploying process in run/DEPLOY and reclaim its orphans

A pause abandoned by a SIGKILLed or rebooted deploy would otherwise halt the
loop until a human noticed. run/DEPLOY names the owner; a deploy-origin marker
whose owner is gone is an orphan. Operator and self pauses are never touched.

run/DEPLOY is safe to add: run/ is only read by listPidEntries, which filters
*.pid, so it cannot become a phantom job in status or stop --kill."
```

---

### Task 4: `tick` reclaims orphaned deploy pauses

**Files:**
- Modify: `plugins/p-shed/tools/lib/tick.mjs:12-27`
- Test: `plugins/p-shed/tools/__tests__/tick.test.ts`

**Interfaces:**
- Consumes: `reclaimOrphanedDeployPauses` (Task 3).
- Produces: `tick` accepts `deps.reclaimOrphanedDeployPauses`. When anything is reclaimed, the returned results array gains one entry `{ action: 'reclaimed-deploy-pause', reclaimed: [...] }` and a log row `{ outcome: 'reclaimed-deploy-pause', reclaimed: [...] }` is appended.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/p-shed/tools/__tests__/tick.test.ts` (match the file's existing helper style for building a root and jobs):

```typescript
describe('orphaned deploy pause reclaim', () => {
  it('runs BEFORE the global-pause gate, so an abandoned deploy pause does not wedge the tick', async () => {
    // The gate short-circuits on any marker regardless of origin, so a reclaim placed
    // after it would never run.
    writeJobs(root, 'version: 1\njobs:\n  - id: w\n    schedule: "* * * * *"\n    prompt: go\n');
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    writeDeployOwner(root, { pid: 999001, scope: 'global', now: 1 });

    const res = await tick({ root, now: Date.now(), deps: { isPidAlive: () => false } });

    expect(Array.isArray(res)).toBe(true);
    expect((res as any[])[0]).toEqual({ action: 'reclaimed-deploy-pause', reclaimed: [{ scope: 'global' }] });
    expect(readGlobalPause(root)).toBeNull();
  });

  it('leaves a live deploy alone — the tick stays short-circuited', async () => {
    writeJobs(root, 'version: 1\njobs:\n  - id: w\n    schedule: "* * * * *"\n    prompt: go\n');
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    writeDeployOwner(root, { pid: process.pid, scope: 'global', now: 1 });

    const res = await tick({ root, now: Date.now() });

    expect(res).toEqual({ action: 'tick', paused: true, launched: 0 });
    expect(readGlobalPause(root)).not.toBeNull();
  });

  it('leaves an operator pause alone and stays short-circuited', async () => {
    writeJobs(root, 'version: 1\njobs:\n  - id: w\n    schedule: "* * * * *"\n    prompt: go\n');
    writeGlobalPause(root, { reason: 'halted by hand' });
    writeDeployOwner(root, { pid: 999001, scope: 'global', now: 1 });

    const res = await tick({ root, now: Date.now(), deps: { isPidAlive: () => false } });

    expect(res).toEqual({ action: 'tick', paused: true, launched: 0 });
    expect(readGlobalPause(root)).not.toBeNull();
  });
});
```

Add the imports this block needs at the top of `tick.test.ts`:

```typescript
import { readGlobalPause, writeGlobalPause } from '../lib/pause.mjs';
import { writeDeployOwner } from '../lib/owner.mjs';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/tick.test.ts`
Expected: FAIL — the first test gets `{action:'tick',paused:true,launched:0}` because the gate wins.

- [ ] **Step 3: Wire the reclaim into the tick**

In `plugins/p-shed/tools/lib/tick.mjs`, add the import and place the reclaim ahead of the global-pause gate:

```javascript
import { reclaimOrphanedDeployPauses } from './owner.mjs';
```

Inside `tick`, add `reclaimOrphanedDeployPauses` to the `d` defaults, then replace the gate block:

```javascript
  // Reclaim FIRST. A pause abandoned by a dead `pshed deploy` must be lifted before the
  // gate below, because that gate short-circuits on ANY marker regardless of origin — a
  // reclaim placed after it would never run and the loop would stay silently halted.
  // Only deploy-origin markers are eligible; an operator pause survives untouched.
  const { reclaimed } = d.reclaimOrphanedDeployPauses(root, { isAlive: d.isPidAlive });
  const preamble = [];
  if (reclaimed.length) {
    preamble.push({ action: 'reclaimed-deploy-pause', reclaimed });
    d.appendLog(root, { ts: now, outcome: 'reclaimed-deploy-pause', reclaimed }, now);
  }

  // Global pause: while run/PAUSED exists the whole scheduler is halted (cron stays
  // installed). This is the FIRST launch gate — before log rotation and any job
  // evaluation — so a paused tick is a genuine no-op.
  if (d.readGlobalPause(root)) return { action: 'tick', paused: true, launched: 0, ...(reclaimed.length ? { reclaimed } : {}) };
```

Then seed the results array with the preamble — replace `const results = [];` with:

```javascript
  const results = [...preamble];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/tick.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run plugins/p-shed`
Expected: all green. If a pre-existing tick test asserts an exact results array, it must still pass — the preamble is only added when something was reclaimed.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/lib/tick.mjs plugins/p-shed/tools/__tests__/tick.test.ts
git commit -m "feat(p-shed): reclaim an orphaned deploy pause at the top of the tick

Placed ahead of the global-pause gate on purpose: that gate short-circuits on
any marker regardless of origin, so a reclaim behind it would never run and a
deploy that died holding a pause would halt the loop until a human noticed.
On Windows this is the only recovery path — a signal trap never fires there."
```

---

### Task 5: `lib/idle.mjs` — who holds this scope, and waiting for them

**Files:**
- Create: `plugins/p-shed/tools/lib/idle.mjs`
- Test: `plugins/p-shed/tools/__tests__/idle.test.ts`

**Interfaces:**
- Consumes: `listRunningJobs` (`lib/pids.mjs`), `resolveGroup` (`lib/concurrency.mjs`).
- Produces:
  - `listHolders({root, jobs, defaults, group, isAlive}): Array<{id, pid}>`
  - `waitForIdle({root, jobs, defaults, group, timeoutMs, pollMs, isAlive, now, sleep, isAborted}): Promise<{idle: boolean, aborted: boolean, waitedMs: number, holders: Array<{id,pid}>}>` — `isAborted()` is polled each cycle so a caller can unwind a long wait (Ctrl+C) instead of blocking to the timeout.

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-shed/tools/__tests__/idle.test.ts`:

```typescript
// "Idle" is answered from p-shed's OWN pidfiles, never from pgrep. Measured on the live
// system: `ssh host "pgrep -f 'claude -p …'"` matches the ssh command itself and reports
// the loop busy forever, and `pkill -f 'until ! pgrep'` killed its own shell.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHolders, waitForIdle } from '../lib/idle.mjs';
import { writePid } from '../lib/pids.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-idle-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const JOBS = [
  { id: 'worker', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
  { id: 'chat', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
  { id: 'other', schedule: '* * * * *', prompt: 'go' },
];

describe('listHolders', () => {
  it('is empty when no pidfile exists', () => {
    expect(listHolders({ root, jobs: JOBS, isAlive: () => true })).toEqual([]);
  });

  it('global scope reports every live job, dead pids dropped', () => {
    writePid(root, 'worker', 111);
    writePid(root, 'other', 222);
    const holders = listHolders({ root, jobs: JOBS, isAlive: (pid: number) => pid === 111 });
    expect(holders).toEqual([{ id: 'worker', pid: 111 }]);
  });

  it('group scope ignores a live job outside the group', () => {
    writePid(root, 'other', 222);
    expect(listHolders({ root, jobs: JOBS, group: 'hft', isAlive: () => true })).toEqual([]);
  });

  it('group scope includes a member inheriting the group from defaults', () => {
    const jobs = [{ id: 'inherits', schedule: '* * * * *', prompt: 'go' }];
    writePid(root, 'inherits', 333);
    const holders = listHolders({ root, jobs, defaults: { concurrencyGroup: 'hft' }, group: 'hft', isAlive: () => true });
    expect(holders).toEqual([{ id: 'inherits', pid: 333 }]);
  });

  it('global scope counts a pidfile whose job is no longer in jobs.yml', () => {
    writePid(root, 'deleted-job', 444);
    expect(listHolders({ root, jobs: JOBS, isAlive: () => true })).toEqual([{ id: 'deleted-job', pid: 444 }]);
  });
});

describe('waitForIdle', () => {
  it('returns immediately when nothing is running', async () => {
    const res = await waitForIdle({ root, jobs: JOBS, timeoutMs: 5000, isAlive: () => true, now: () => 0, sleep: async () => {} });
    expect(res.idle).toBe(true);
    expect(res.holders).toEqual([]);
  });

  it('blocks while a holder is live, then proceeds when it exits', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    let liveChecks = 0;
    const isAlive = () => { liveChecks++; return liveChecks <= 2; }; // dies on the 3rd poll
    const res = await waitForIdle({
      root, jobs: JOBS, timeoutMs: 60_000, pollMs: 1000,
      isAlive, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    });
    expect(res.idle).toBe(true);
    expect(res.waitedMs).toBe(2000);
  });

  it('times out and names the holder without pausing anything', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    const res = await waitForIdle({
      root, jobs: JOBS, timeoutMs: 3000, pollMs: 1000,
      isAlive: () => true, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    });
    expect(res.idle).toBe(false);
    expect(res.holders).toEqual([{ id: 'worker', pid: 111 }]);
    expect(res.waitedMs).toBeGreaterThanOrEqual(3000);
  });

  it('checks once even with a zero timeout (idle is still idle)', async () => {
    const res = await waitForIdle({ root, jobs: JOBS, timeoutMs: 0, isAlive: () => true, now: () => 0, sleep: async () => {} });
    expect(res.idle).toBe(true);
  });

  it('stops waiting when cancelled, and says so', async () => {
    // Ctrl+C during a 30-minute wait must not be ignored: the caller has to be able to
    // unwind and release, not sit in the poll loop until the timeout.
    writePid(root, 'worker', 111);
    let clock = 0;
    let polls = 0;
    const res = await waitForIdle({
      root, jobs: JOBS, timeoutMs: 600_000, pollMs: 1000,
      isAlive: () => true, now: () => clock, sleep: async (ms: number) => { clock += ms; },
      isAborted: () => ++polls >= 3,
    });
    expect(res).toMatchObject({ idle: false, aborted: true });
    expect(res.holders).toEqual([{ id: 'worker', pid: 111 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/idle.test.ts`
Expected: FAIL — `Cannot find module '../lib/idle.mjs'`.

- [ ] **Step 3: Create `lib/idle.mjs`**

```javascript
import { isPidAlive, listRunningJobs } from './pids.mjs';
import { resolveGroup } from './concurrency.mjs';

// Who is holding this scope right now, answered from p-shed's OWN per-job pidfiles.
// Never from pgrep: measured on the live system, `ssh host "pgrep -f 'claude -p …'"`
// matches the ssh command itself and reports the loop busy forever.
//
// Global scope counts every live pidfile, including one whose job has since been removed
// from jobs.yml — that process is still writing the checkout, which is the whole
// question being asked. Group scope uses resolveGroup, so `defaults` inheritance and an
// explicit `null` opt-out behave exactly as the tick's group gate does.
export function listHolders({ root, jobs = [], defaults = {}, group = null, isAlive = isPidAlive } = {}) {
  const live = listRunningJobs(root, { isAlive });
  if (!group) return live;
  const members = new Set(jobs.filter((j) => resolveGroup(j, defaults) === group).map((j) => j.id));
  return live.filter((e) => members.has(e.id));
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Block until the scope is free, or the timeout expires. Changes NO state — this is the
// honest primitive, and it is what a human wants when the next step is manual. The
// liveness check comes before the deadline check so a zero timeout still answers
// truthfully for an already-idle loop.
export async function waitForIdle({
  root, jobs = [], defaults = {}, group = null,
  timeoutMs = 1_800_000, pollMs = 1000,
  isAlive = isPidAlive, now = () => Date.now(), sleep = realSleep,
  isAborted = () => false,
} = {}) {
  const started = now();
  for (;;) {
    const holders = listHolders({ root, jobs, defaults, group, isAlive });
    if (holders.length === 0) return { idle: true, aborted: false, waitedMs: now() - started, holders: [] };
    // Cancellation is checked alongside the deadline, not only around the command: a
    // Ctrl+C thirty seconds into a thirty-minute wait must unwind now, so the caller can
    // release whatever it holds instead of sitting here until the timeout.
    if (isAborted()) return { idle: false, aborted: true, waitedMs: now() - started, holders };
    if (now() - started >= timeoutMs) return { idle: false, aborted: false, waitedMs: now() - started, holders };
    await sleep(pollMs);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/idle.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/idle.mjs plugins/p-shed/tools/__tests__/idle.test.ts
git commit -m "feat(p-shed): add lib/idle.mjs — holders of a scope, and waiting for them

Answered from p-shed's own pidfiles rather than pgrep: a remote pgrep matches
the ssh command running it and reports the loop busy forever. Clock, sleep and
liveness are injected so the wait is tested without real processes or real time."
```

---

### Task 6: `lib/deploy.mjs` — the indivisible dance

**Files:**
- Create: `plugins/p-shed/tools/lib/deploy.mjs`
- Test: `plugins/p-shed/tools/__tests__/deploy.test.ts`

**Interfaces:**
- Consumes: `waitForIdle`, `listHolders` (Task 5); `writeDeployOwner`, `removeDeployOwner` (Task 3); `writeGlobalPause`, `removeGlobalPause` (`lib/pause.mjs`); `writePause`, `readPauseRecord`, `removePause` (Task 2).
- Produces: `runDeploy(opts): Promise<Result>` where

```
opts   = { root, jobs, defaults, group, reason, timeoutMs, pollMs, cmd, args, pid, deps }
         deps.isAborted?: () => boolean   // polled during the wait; see Task 5
Result = { outcome: 'ok' | 'timeout' | 'aborted', exit: number,
           waitedMs: number, attempts: number,
           scope: 'global' | 'group', group: string | null,
           pausedIds: string[], ownedGlobal: boolean,
           preserved: Array<{scope:'global'} | {scope:'job', id:string, origin:string}>,
           holders?: Array<{id, pid}> }
```

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-shed/tools/__tests__/deploy.test.ts`:

```typescript
// The dance is indivisible, and its ORDER is the point. Measured on the live system:
// pausing before waiting for idle silenced the read-only chat jobs for the entire
// remaining run of a 30-minute worker (phone dark for 20 minutes).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeploy } from '../lib/deploy.mjs';
import { readGlobalPause, writeGlobalPause, globalPausePath } from '../lib/pause.mjs';
import { writePause, readPauseRecord, pausePath } from '../lib/breaker.mjs';
import { readDeployOwner, deployOwnerPath } from '../lib/owner.mjs';
import { writePid } from '../lib/pids.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-deploy-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const JOBS = [
  { id: 'worker', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
  { id: 'chat', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
];

// A spawn stub returning a chosen exit code. It deliberately does NOT record the call —
// step order is recorded by onStep alone, so the two can never double-count.
const fakeSpawn = (exit: number) => async () => ({ exit, signal: null });

const base = (over: any = {}) => ({
  root, jobs: JOBS, defaults: {}, reason: 'prompt update',
  timeoutMs: 60_000, pollMs: 1000, cmd: 'git', args: ['pull'], pid: 4242,
  deps: { spawn: fakeSpawn(0), isAlive: () => false, now: () => 0, sleep: async () => {} },
  ...over,
});

describe('order of operations', () => {
  it('waits for idle BEFORE pausing, then runs, then releases', async () => {
    const order: string[] = [];
    const res = await runDeploy(base({
      deps: {
        spawn: fakeSpawn(0), isAlive: () => false, now: () => 0, sleep: async () => {},
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(order).toEqual(['wait', 'pause', 'recheck', 'run', 'release']);
    expect(res.outcome).toBe('ok');
    expect(res.exit).toBe(0);
  });

  it('leaves nothing behind: no pause, no run/DEPLOY', async () => {
    await runDeploy(base());
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('records the owner in run/DEPLOY while the command runs', async () => {
    let seen: any = null;
    await runDeploy(base({
      deps: {
        spawn: async () => { seen = readDeployOwner(root); return { exit: 0, signal: null }; },
        isAlive: () => false, now: () => 0, sleep: async () => {},
      },
    }));
    expect(seen).toMatchObject({ pid: 4242, scope: 'global', reason: 'prompt update' });
  });

  it('the pause it places carries the deploy origin and the reason', async () => {
    let marker: any = null;
    await runDeploy(base({
      deps: {
        spawn: async () => { marker = readGlobalPause(root); return { exit: 0, signal: null }; },
        isAlive: () => false, now: () => 0, sleep: async () => {},
      },
    }));
    expect(marker).toMatchObject({ origin: 'deploy', reason: 'prompt update' });
  });
});

describe('the race between waiting and pausing', () => {
  it('undoes its own pause and retries when a job launches in the gap', async () => {
    // Idle on the first wait; a holder appears once the pause is placed, then goes away.
    let phase = 0;
    const order: string[] = [];
    const res = await runDeploy(base({
      deps: {
        spawn: fakeSpawn(0),
        // pid 111 is "alive" only during the first re-check
        isAlive: () => phase === 1,
        now: () => 0, sleep: async () => {},
        onStep: (s: string) => {
          order.push(s);
          if (s === 'pause' && phase === 0) { writePid(root, 'worker', 111); phase = 1; }
          if (s === 'recheck' && phase === 1) { phase = 2; }
        },
      },
    }));
    expect(order).toEqual(['wait', 'pause', 'recheck', 'undo', 'wait', 'pause', 'recheck', 'run', 'release']);
    expect(res.attempts).toBe(2);
    expect(res.outcome).toBe('ok');
    expect(readGlobalPause(root)).toBeNull();
  });
});

describe('release is unconditional', () => {
  it('releases and propagates the code when the command fails', async () => {
    const res = await runDeploy(base({ deps: { spawn: fakeSpawn(17), isAlive: () => false, now: () => 0, sleep: async () => {} } }));
    expect(res.exit).toBe(17);
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('releases when the command throws', async () => {
    const boom = async () => { throw new Error('spawn exploded'); };
    await expect(runDeploy(base({ deps: { spawn: boom, isAlive: () => false, now: () => 0, sleep: async () => {} } }))).rejects.toThrow('spawn exploded');
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });
});

describe('a pre-existing pause is preserved', () => {
  it('does not remove a global operator pause it walked into', async () => {
    writeGlobalPause(root, { reason: 'halted by hand' });
    const res = await runDeploy(base());
    expect(res.ownedGlobal).toBe(false);
    expect(res.preserved).toEqual([{ scope: 'global' }]);
    expect(readGlobalPause(root)).not.toBeNull();
    expect(readGlobalPause(root)!.reason).toBe('halted by hand');
  });

  it('group scope: pauses only the members it actually placed', async () => {
    writePause(root, 'chat', { reason: 'by hand', origin: 'operator' });
    const res = await runDeploy(base({ group: 'hft' }));
    expect(res.scope).toBe('group');
    expect(res.pausedIds).toEqual(['worker']);
    expect(res.preserved).toEqual([{ scope: 'job', id: 'chat', origin: 'operator' }]);
    expect(existsSync(pausePath(root, 'worker'))).toBe(false);          // released
    expect(readPauseRecord(root, 'chat')).toEqual({ origin: 'operator', reason: 'by hand' });
  });
});

describe('cancellation', () => {
  it('unwinds a wait that was cancelled, pausing and running nothing', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    let polls = 0;
    const order: string[] = [];
    const res = await runDeploy(base({
      timeoutMs: 600_000,
      deps: {
        spawn: fakeSpawn(0), isAlive: () => true,
        now: () => clock, sleep: async (ms: number) => { clock += ms; },
        isAborted: () => ++polls >= 2,
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(res.outcome).toBe('aborted');
    expect(order).not.toContain('pause');
    expect(order).not.toContain('run');
    expect(existsSync(globalPausePath(root))).toBe(false);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });
});

describe('timeout', () => {
  it('pauses nothing and runs nothing when the wait times out', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    const order: string[] = [];
    const res = await runDeploy(base({
      timeoutMs: 3000,
      deps: {
        spawn: fakeSpawn(0), isAlive: () => true,
        now: () => clock, sleep: async (ms: number) => { clock += ms; },
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(res.outcome).toBe('timeout');
    expect(res.holders).toEqual([{ id: 'worker', pid: 111 }]);
    expect(order).not.toContain('pause');
    expect(order).not.toContain('run');
    expect(existsSync(globalPausePath(root))).toBe(false);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/deploy.test.ts`
Expected: FAIL — `Cannot find module '../lib/deploy.mjs'`.

- [ ] **Step 3: Create `lib/deploy.mjs`**

```javascript
import { isPidAlive } from './pids.mjs';
import { listHolders, waitForIdle } from './idle.mjs';
import { writeDeployOwner, removeDeployOwner } from './owner.mjs';
import { writeGlobalPause, removeGlobalPause, readGlobalPause } from './pause.mjs';
import { writePause, readPauseRecord, removePause } from './breaker.mjs';
import { resolveGroup } from './concurrency.mjs';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

// The deploy dance. The ORDER is the feature:
//   own -> wait -> pause -> re-check -> run -> release
// Pausing before waiting for idle silences every job — including the read-only chat
// ones — for the entire remaining run of an in-flight worker; measured on the live
// system as 20 minutes of silence. Waiting first costs about four seconds.
//
// The re-check exists because a job can launch in the gap between "idle" and "paused".
// When that happens we undo our own pause and go back to waiting, inside whatever is
// left of the timeout, rather than deploying into a live run.
export async function runDeploy({
  root, jobs = [], defaults = {}, group = null, reason,
  timeoutMs = 1_800_000, pollMs = 1000,
  cmd, args = [], pid = process.pid, deps = {},
} = {}) {
  const d = {
    waitForIdle, listHolders, isAlive: isPidAlive,
    now: () => Date.now(), sleep: realSleep, onStep: noop, isAborted: () => false,
    spawn: null, // required; the CLI injects the real one
    ...deps,
  };
  const scope = group ? 'group' : 'global';
  const started = d.now();
  const remaining = () => Math.max(0, timeoutMs - (d.now() - started));
  const members = () => jobs.filter((j) => resolveGroup(j, defaults) === group).map((j) => j.id);

  // Ownership is claimed BEFORE any pause, so the "marker exists, owner unknown" window
  // cannot open. If this process dies from here on, the next tick reclaims whatever it
  // placed — the only recovery path on Windows, where no signal reaches a handler.
  writeDeployOwner(root, { pid, scope, group, reason, now: d.now() });

  let pausedIds = [];
  let ownedGlobal = false;
  let preserved = [];
  let attempts = 0;

  const release = () => {
    if (ownedGlobal) removeGlobalPause(root);
    for (const id of pausedIds) removePause(root, id);
    pausedIds = [];
    ownedGlobal = false;
    removeDeployOwner(root);
  };

  try {
    for (;;) {
      attempts++;
      d.onStep('wait');
      const waited = await d.waitForIdle({
        root, jobs, defaults, group, timeoutMs: remaining(), pollMs,
        isAlive: d.isAlive, now: d.now, sleep: d.sleep, isAborted: d.isAborted,
      });
      if (!waited.idle) {
        // Nothing was paused and nothing ran — the honest failure, whether the wait ran
        // out or the operator interrupted it. Ownership is dropped by the finally below.
        return {
          outcome: waited.aborted ? 'aborted' : 'timeout', exit: waited.aborted ? 130 : 1,
          waitedMs: d.now() - started, attempts,
          scope, group, pausedIds: [], ownedGlobal: false, preserved: [], holders: waited.holders,
        };
      }

      d.onStep('pause');
      preserved = [];
      if (scope === 'global') {
        const before = readGlobalPause(root);
        if (before) preserved.push({ scope: 'global' });
        else { writeGlobalPause(root, { reason, origin: 'deploy', now: d.now() }); ownedGlobal = true; }
      } else {
        for (const id of members()) {
          const existing = readPauseRecord(root, id);
          if (existing) { preserved.push({ scope: 'job', id, origin: existing.origin }); continue; }
          writePause(root, id, { reason, origin: 'deploy' });
          pausedIds.push(id);
        }
      }

      d.onStep('recheck');
      const stragglers = d.listHolders({ root, jobs, defaults, group, isAlive: d.isAlive });
      if (stragglers.length === 0) break;

      // A job started in the gap. Undo only what we placed, then wait again.
      d.onStep('undo');
      if (ownedGlobal) removeGlobalPause(root);
      for (const id of pausedIds) removePause(root, id);
      pausedIds = [];
      ownedGlobal = false;
      if (remaining() === 0) {
        return {
          outcome: 'timeout', exit: 1, waitedMs: d.now() - started, attempts,
          scope, group, pausedIds: [], ownedGlobal: false, preserved: [], holders: stragglers,
        };
      }
    }

    d.onStep('run');
    const result = await d.spawn({ cmd, args });
    return {
      outcome: 'ok', exit: result.exit, signal: result.signal ?? null,
      waitedMs: d.now() - started, attempts, scope, group,
      pausedIds: [...pausedIds], ownedGlobal, preserved,
    };
  } finally {
    // Unconditional: success, non-zero exit, a throw, or (on POSIX) a signal that got
    // this far. A deploy that dies holding a global pause takes the whole loop down.
    d.onStep('release');
    release();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/deploy.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run plugins/p-shed`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/lib/deploy.mjs plugins/p-shed/tools/__tests__/deploy.test.ts
git commit -m "feat(p-shed): add lib/deploy.mjs — wait, pause, run, always release

The order is the feature. Pausing before waiting for idle silences every job,
chat ones included, for the whole remaining run of an in-flight worker; waiting
first costs seconds. A job that launches between the wait and the pause is
handled by undoing our own pause and waiting again, and release runs in a
finally so a failed or interrupted command never leaves the loop halted.

A pause we walked into is never removed — resuming a deliberate halt is worse
than not deploying."
```

---

### Task 7: `pshed wait-idle`

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs` (`KNOWN`, a new command block)
- Test: `plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts` (created here, extended in Task 8)

**Interfaces:**
- Consumes: `waitForIdle` (Task 5), `resolveTarget` (`lib/target.mjs`).
- Produces: CLI `pshed wait-idle [--group <name>] [--timeout-sec <n>] [--poll-ms <n>] [--json]`; JSON on stdout `{action:'wait-idle', idle, scope, group, waitedMs, holders}`; exit 0 idle, 1 timeout, 2 validation.

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`:

```typescript
// End-to-end over the real CLI. wait-idle is the honest primitive: it changes NO state,
// so every assertion here also checks that run/PAUSED stayed absent.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-deploye2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const pshed = (...p: string[]) => join(root, '.pshed', ...p);
const cli = (args: string[]) => spawnSync('node', [CLI, ...args], { encoding: 'utf-8', cwd: root });

function writeJobs(yml: string) {
  mkdirSync(pshed(), { recursive: true });
  writeFileSync(pshed('jobs.yml'), yml, 'utf-8');
}
const TWO_JOBS = `version: 1
jobs:
  - id: worker
    schedule: "* * * * *"
    prompt: go
    concurrencyGroup: hft
  - id: chat
    schedule: "* * * * *"
    prompt: go
`;

// A live pidfile for a process that really exists, so isPidAlive says "busy".
function claimPid(id: string, pid = process.pid) {
  mkdirSync(pshed('run'), { recursive: true });
  writeFileSync(pshed('run', `${id}.pid`), String(pid), 'utf-8');
}

describe('wait-idle', () => {
  it('exits 0 immediately on an idle loop and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'wait-idle', idle: true, scope: 'global' });
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('exits 1 on timeout, names the holder, and still pauses nothing', () => {
    writeJobs(TWO_JOBS);
    claimPid('worker');
    const r = cli(['wait-idle', '--timeout-sec', '0', '--json']);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.idle).toBe(false);
    expect(out.holders).toEqual([{ id: 'worker', pid: process.pid }]);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('scopes to a group: a live job outside it does not count', () => {
    writeJobs(TWO_JOBS);
    claimPid('chat');                       // chat has no concurrencyGroup
    const r = cli(['wait-idle', '--group', 'hft', '--timeout-sec', '0', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).idle).toBe(true);
  });

  it('exits 2 on an unknown group and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--group', 'nope', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('validation');
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`
Expected: FAIL — exit code 1 with `unknown command: wait-idle` on stderr.

- [ ] **Step 3: Wire the command into the CLI**

In `plugins/p-shed/tools/pshed.mjs`, add the import:

```javascript
import { waitForIdle } from './lib/idle.mjs';
```

Extend `KNOWN`:

```javascript
const KNOWN = ['tick', 'run', 'install-cron', 'remove-cron', 'set-job', 'rm-job', 'reset-breaker', 'pause', 'resume', 'status', 'stop', 'wait-idle', 'deploy'];
```

Add the command block inside `main`'s `try`, next to `pause`/`resume`:

```javascript
    // wait-idle: block until nothing in scope is running. Changes NO state — it is the
    // primitive `deploy` is built from, and what a human wants when the next step is
    // manual. resolveTarget is reused so an unknown group is a loud exit 2, never a
    // silent widening to "the whole scheduler".
    if (command === 'wait-idle') {
      const { defaults, jobs } = readJobs(root);
      if (args.id !== undefined) {
        return emitJson({ error: { code: 'validation', message: 'wait-idle has no --id: use --group, or no flag for the whole scheduler' } }, 2);
      }
      const target = resolveTarget({ jobs, defaults, group: args.group });
      const group = target ? target.group : null;
      const res = await waitForIdle({
        root, jobs, defaults, group,
        timeoutMs: timeoutMsFrom(args), pollMs: pollMsFrom(args),
      });
      return emitJson({
        action: 'wait-idle', idle: res.idle, scope: group ? 'group' : 'global', group,
        waitedMs: res.waitedMs, holders: res.holders,
      }, res.idle ? 0 : 1);
    }
```

Add the two option helpers next to `findRoot` in the same file:

```javascript
// --timeout-sec / --poll-ms, shared by wait-idle and deploy. Defaults: 1800 s (the
// longest observed worker run) and a 1 s poll. A non-numeric or negative value is a
// validation error rather than a silently-infinite wait.
export function timeoutMsFrom(args) {
  const raw = args['timeout-sec'];
  if (raw === undefined) return 1_800_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError('--timeout-sec must be a non-negative number of seconds');
  return Math.round(n * 1000);
}

export function pollMsFrom(args) {
  const raw = args['poll-ms'];
  if (raw === undefined) return 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new ValidationError('--poll-ms must be at least 1');
  return Math.round(n);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts
git commit -m "feat(p-shed): add the wait-idle command

Blocks until no job in scope holds a live pidfile. Changes no state, so it is
also the honest answer when the next step is manual. An unknown group exits 2
and pauses nothing, reusing resolveTarget."
```

---

### Task 8: `pshed deploy`

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs`
- Test: `plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`

**Interfaces:**
- Consumes: `runDeploy` (Task 6), `timeoutMsFrom` / `pollMsFrom` (Task 7).
- Produces: CLI `pshed deploy --reason "<text>" [--group <name>] [--timeout-sec <n>] [--poll-ms <n>] [--json] -- <cmd> [args...]`; the command's stdout/stderr are inherited, p-shed's report goes to **stderr**, exit code is the command's.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`:

```typescript
describe('deploy', () => {
  const NODE = process.execPath;

  it('runs the command, propagates its exit code, and leaves nothing paused', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'prompt update', '--', NODE, '-e', 'process.exit(0)']);
    expect(r.status).toBe(0);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('propagates a non-zero exit code and still releases', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'prompt update', '--', NODE, '-e', 'process.exit(17)']);
    expect(r.status).toBe(17);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('passes a command carrying its own flags through untouched', () => {
    writeJobs(TWO_JOBS);
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const r = cli(['deploy', '--reason', 'x', '--', NODE, '-e', script, '--json', '--group', 'not-ours']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"--json"');
    expect(r.stdout).toContain('"--group"');
  });

  it('keeps its own report out of the command stdout', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--json', '--', NODE, '-e', 'console.log("COMMAND-OUTPUT")']);
    expect(r.stdout.trim()).toBe('COMMAND-OUTPUT');
    expect(JSON.parse(r.stderr)).toMatchObject({ action: 'deploy', outcome: 'ok', exit: 0 });
  });

  it('exits 2 on --id and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--id', 'worker', '--json', '--', NODE, '-e', '0']);
    expect(r.status).toBe(2);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('exits 2 without --reason, without -- and without a command', () => {
    writeJobs(TWO_JOBS);
    expect(cli(['deploy', '--json', '--', NODE, '-e', '0']).status).toBe(2);
    expect(cli(['deploy', '--reason', 'x', '--json']).status).toBe(2);
    expect(cli(['deploy', '--reason', 'x', '--json', '--']).status).toBe(2);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('exits 1 on timeout: nothing paused, nothing run', () => {
    writeJobs(TWO_JOBS);
    claimPid('worker');
    const r = cli(['deploy', '--reason', 'x', '--timeout-sec', '0', '--json', '--', NODE, '-e', 'console.log("MUST-NOT-RUN")']);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('MUST-NOT-RUN');
    expect(JSON.parse(r.stderr)).toMatchObject({ action: 'deploy', outcome: 'timeout' });
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('releases even when the command cannot be spawned at all', () => {
    // The exit code differs by platform and that is inherent, not a bug: measured, with
    // shell:true (win32) a missing binary is reported by the shell as exit 1, while a
    // shell-less POSIX spawn raises ENOENT, which maps to the conventional 127. What must
    // hold on BOTH is that the loop is left un-paused.
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--json', '--', 'definitely-not-a-real-binary-xyz']);
    expect(r.status).toBe(process.platform === 'win32' ? 1 : 127);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('run/DEPLOY creates no phantom job in status and none in stop --kill', () => {
    writeJobs(TWO_JOBS);
    mkdirSync(pshed('run'), { recursive: true });
    writeFileSync(pshed('run', 'DEPLOY'), JSON.stringify({ pid: process.pid, scope: 'global' }), 'utf-8');

    const st = JSON.parse(cli(['status', '--json']).stdout);
    expect(st.jobs.map((j: any) => j.id).sort()).toEqual(['chat', 'worker']);

    // stop --kill enumerates run/*.pid and terminates each as a job. A DEPLOY file that
    // leaked into that list would make the teardown try to kill the deploying process.
    const stopped = JSON.parse(cli(['stop', '--kill', '--json']).stdout);
    expect(stopped.killed).toEqual({ terminated: 0, ids: [] });
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(true);
  });
});

// POSIX only: measured, a Node process on Windows receives neither SIGINT nor SIGTERM —
// the handler never fires — so there is nothing to assert there. The reclaim in the tick
// is what covers Windows, and owner.test.ts covers the reclaim.
describe.skipIf(process.platform === 'win32')('deploy releases on a signal', () => {
  it('SIGINT during the command still clears the pause and run/DEPLOY', async () => {
    writeJobs(TWO_JOBS);
    const { spawn } = await import('node:child_process');
    const child = spawn('node', [CLI, 'deploy', '--reason', 'x', '--', process.execPath, '-e', 'setTimeout(()=>{},10000)'], { cwd: root, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(true);   // paused while it runs
    child.kill('SIGINT');
    await new Promise((r) => child.on('exit', r));
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  }, 20_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`
Expected: FAIL — `unknown command: deploy`.

- [ ] **Step 3: Implement the command**

In `plugins/p-shed/tools/pshed.mjs` add the import:

```javascript
import { runDeploy } from './lib/deploy.mjs';
import { spawn } from 'node:child_process';
```

Add the command block after `wait-idle`:

```javascript
    // deploy: the indivisible dance. Its report goes to STDERR on purpose — stdout and
    // stderr belong to the deployed command, and mixing a scheduler JSON blob into
    // `git push` output would make both unparseable.
    if (command === 'deploy') {
      const { defaults, jobs } = readJobs(root);
      const cmdv = args['--'];
      // --id is REJECTED, not ignored: parseArgs swallows unknown flags, so accepting it
      // silently would pause the ENTIRE scheduler while the operator believes one job was
      // targeted — the regression lib/target.mjs exists to prevent.
      if (args.id !== undefined) {
        return emitJson({ error: { code: 'validation', message: 'deploy has no --id: a groupmate would keep writing the same checkout. Use --group, or no flag for the whole scheduler' } }, 2);
      }
      if (typeof args.reason !== 'string' || args.reason.trim() === '') {
        return emitJson({ error: { code: 'validation', message: 'deploy requires --reason "<text>": it lands in the pause marker, and a halted loop with no stated reason is what status exists to prevent' } }, 2);
      }
      if (cmdv === undefined) {
        return emitJson({ error: { code: 'validation', message: 'deploy requires a command after --, e.g. pshed deploy --reason "x" -- git pull' } }, 2);
      }
      if (cmdv.length === 0) {
        return emitJson({ error: { code: 'validation', message: 'no command after --' } }, 2);
      }
      const target = resolveTarget({ jobs, defaults, group: args.group });

      // POSIX signal handling. Two distinct moments need covering and a naive trap only
      // covers one: an interrupt DURING the wait (no child exists yet) and one during the
      // command. A cancel flag handles the first — waitForIdle polls it and unwinds — and
      // killing the child handles the second. Both then fall through runDeploy's finally,
      // which is what actually releases. Calling process.exit() from the handler would
      // SKIP that finally and leave the loop paused, so it must not appear here.
      // Measured: on Windows neither SIGINT nor SIGTERM ever reaches a handler, so this
      // is POSIX-only and the tick's reclaim is what covers that platform.
      let cancelled = false;
      if (process.platform !== 'win32') {
        for (const sig of ['SIGINT', 'SIGTERM']) {
          process.on(sig, () => { cancelled = true; deployChild?.kill(sig); });
        }
      }

      const res = await runDeploy({
        root, jobs, defaults, group: target ? target.group : null,
        reason: args.reason, timeoutMs: timeoutMsFrom(args), pollMs: pollMsFrom(args),
        cmd: cmdv[0], args: cmdv.slice(1),
        deps: { spawn: spawnInherit, isAborted: () => cancelled },
      });
      const report = { action: 'deploy', ...res };
      process.stderr.write(args.json ? JSON.stringify(report) + '\n' : formatDeploy(report) + '\n');
      process.exit(res.outcome === 'ok' ? res.exit : (res.outcome === 'aborted' ? 130 : 1));
    }
```

Add the spawn adapter and the human formatter near the bottom of `pshed.mjs`, above `isTickInstalled`:

```javascript
// Run the deployed command with stdio inherited, so its output reaches the operator
// unchanged and p-shed adds nothing to it. `shell` on win32 only: measured,
// spawn('npm', …) is ENOENT there because npm is a .cmd shim, while POSIX must stay
// shell-less so the arguments are not re-interpreted.
// Exit conventions: 128+signum for a signalled command, 127 for one that could not be
// spawned — the same numbers a shell would report.
function spawnInherit({ cmd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    deployChild = child; // so a POSIX signal handler can forward the interrupt
    child.on('error', (e) => (e.code === 'ENOENT' ? resolve({ exit: 127, signal: null }) : reject(e)));
    child.on('exit', (code, signal) => {
      if (signal) return resolve({ exit: 128 + (osSignalNumber(signal) ?? 0), signal });
      resolve({ exit: code ?? 0, signal: null });
    });
  });
}

function osSignalNumber(signal) {
  const table = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal];
}

function formatDeploy(r) {
  if (r.outcome === 'timeout') {
    const who = r.holders.map((h) => `${h.id} (pid ${h.pid})`).join(', ') || 'unknown';
    return `deploy: timed out after ${Math.round(r.waitedMs / 1000)}s waiting for ${who}; nothing paused, nothing run`;
  }
  const scope = r.scope === 'group' ? `group ${r.group}` : 'the scheduler';
  const kept = r.preserved.length ? `; kept ${r.preserved.length} pre-existing pause(s)` : '';
  return `deploy: waited ${Math.round(r.waitedMs / 1000)}s, paused ${scope}, command exited ${r.exit}, released${kept}`;
}
```

Finally, declare the child handle the signal block above refers to. Add this module-level
`let` next to `KNOWN` in `pshed.mjs`:

```javascript
// The in-flight deployed command, so a POSIX signal handler can forward the interrupt to
// it. Null while `deploy` is still waiting for idle — that phase is cancelled by the flag
// instead, since there is no child to signal yet.
let deployChild = null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts`
Expected: PASS — 14 tests on POSIX; on Windows 13 pass and the signal test reports as skipped.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run plugins/p-shed`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-deploy-e2e.test.ts
git commit -m "feat(p-shed): add the deploy command

Waits for idle, pauses, runs the command with stdio inherited, and always
releases. The report goes to stderr because stdout belongs to the command.
--id is rejected rather than ignored: parseArgs swallows unknown flags, so
accepting it would pause the whole scheduler while the operator believes one
job was targeted. shell:true on win32 only, where npm and friends are .cmd
shims that spawn cannot resolve otherwise."
```

---

### Task 9: Documentation

**Files:**
- Modify: `plugins/p-shed/README.md` (command table, `.pshed/` layout table)
- Modify: `plugins/p-shed/CLAUDE.md` (a new decision entry)
- Modify: `plugins/p-shed/.claude-plugin/plugin.json` (description only — **not** the version)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add both commands to the README table**

In `plugins/p-shed/README.md`, add two rows to the command table, after `pause` / `resume`:

```markdown
| `wait-idle` | Block until no job (or no member of `--group`) holds a live pidfile. Changes no state. `--timeout-sec` (default 1800), `--poll-ms` (default 1000). Exit `0` idle / `1` timed out (holder named) / `2` validation. |
| `deploy` | Open a maintenance window and run a command in it: wait for idle → pause → re-check → run → always release. `--reason` required, `--group` optional, then `-- <cmd> [args...]`. The command's stdout/stderr pass through untouched and its exit code becomes `deploy`'s; p-shed's own report goes to stderr. |
```

- [ ] **Step 2: Add `run/DEPLOY` to the `.pshed/` layout table**

```markdown
| `run/DEPLOY` | no | `{pid, scope, group, reason, createdAt}` — the process holding a deploy pause. Written before the pause; the tick reclaims any deploy-origin pause whose owner is gone. |
```

- [ ] **Step 3: Add the decision entry to the plugin's CLAUDE.md**

Append to `plugins/p-shed/CLAUDE.md`:

```markdown
- **`wait-idle` waits; the TICK still never does.** The "not now, next tick" rule above
  governs the scheduler: a held concurrency group is a skip, never a queue or a lock, and
  that must not change. `wait-idle` and `deploy` are foreground OPERATOR commands — a
  human (or a deploy script) is blocked on them, no job's `timeoutSec` budget is being
  charged, and nothing is queued. Do not "unify" the two by teaching the tick to wait, and
  do not delete the wait as a violation of the tick's rule: they answer different questions.
- **The deploy dance is ordered, and the order is load-bearing.** wait-idle → pause →
  re-check → run → release. Pausing FIRST silences every job, chat included, for the whole
  remaining run of an in-flight worker (measured: 20 minutes of silence); waiting first
  costs seconds. The re-check exists because a job can launch in the gap; when it does,
  `deploy` undoes only its own pause and waits again.
- **Ownership is a file, not a signal trap.** `run/DEPLOY` names the process holding a
  deploy pause, and `tick` reclaims a deploy-origin marker whose owner is dead — BEFORE
  its global-pause gate, since that gate short-circuits on any marker regardless of
  origin. This is not belt-and-braces: measured, a Node process on Windows receives
  neither SIGTERM nor SIGINT, so a trap cannot be the mechanism there at all. Do not put
  the owner pid in the pause header — `#pshed origin=deploy pid=123` fails `ORIGIN_HEADER`,
  reads back as a SELF pause, and `reset-breaker` on an unrelated job then deletes a live
  deploy's pause. Do not name the file `*.pid` either: `listPidEntries` would invent a
  phantom job for `status` and `stop --kill`.
- **`deploy` has no `--id`, and rejects it loudly.** Pausing one job while a groupmate
  keeps writing the same checkout is a window that only looks safe. `parseArgs` swallows
  unknown flags, so ignoring `--id` would silently mean "pause everything" — the same
  blast-radius widening `lib/target.mjs` exists to prevent.
```

- [ ] **Step 4: Update the plugin description**

In `plugins/p-shed/.claude-plugin/plugin.json`, extend the `description`'s command list from
`Commands (tool \`pshed\`): tick, run, install-cron, remove-cron, set-job, rm-job, reset-breaker, pause, resume, status, stop.`
to
`Commands (tool \`pshed\`): tick, run, install-cron, remove-cron, set-job, rm-job, reset-breaker, pause, resume, status, stop, wait-idle, deploy.`
and add one sentence before the command list:
`A maintenance window is a first-class command: \`deploy\` waits for the loop to go idle, pauses it, runs a command with its output passed through, and always releases — reclaiming its own pause via the next tick if the deploying process is killed.`

**Do not touch `"version"`.** Releases are cut only when the repo owner explicitly asks.

- [ ] **Step 5: Verify the docs match the code**

Run: `npx vitest run plugins/p-shed`
Expected: all green — `skills-structure.test.ts` is the one that checks plugin metadata consistency.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/README.md plugins/p-shed/CLAUDE.md plugins/p-shed/.claude-plugin/plugin.json
git commit -m "docs(p-shed): document wait-idle, deploy and run/DEPLOY

Includes the contributor rules that keep this from being 'simplified' away:
the tick still never waits, the dance's order is load-bearing, ownership is a
file rather than a signal trap, and deploy rejects --id instead of ignoring it."
```

---

## Verification

After Task 9, confirm the whole feature end-to-end:

- [ ] `npx vitest run plugins/p-shed` — expected: **30 files, 368 tests** (baseline 26 files / 309 tests, plus 4+6+12+3+10+10+14 from Tasks 1-8). On Windows one of them reports as skipped, not failed: the SIGINT test. Any other skip is a bug in the run, not an expected result.
- [ ] `node plugins/p-shed/tools/pshed.mjs wait-idle --json` from a repo with no `.pshed/` — expected: `{"action":"wait-idle","idle":true,...}`, exit 0.
- [ ] `node plugins/p-shed/tools/pshed.mjs deploy --reason "smoke" -- node -e "console.log('hi')"` — expected: `hi` on stdout, a one-line report on stderr, exit 0, and no `.pshed/run/PAUSED` or `.pshed/run/DEPLOY` left behind.
