# p-shed Speed Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One operator-owned word (`eco` / `fast`) changes the whole loop's pace, with the active value storable outside the repository the loop writes to.

**Architecture:** A `profiles:` table in `jobs.yml` maps profile name → job id → partial job overrides. `lib/profile.mjs` resolves which profile is active (env → file → `defaults.profile` → none) and layers its overrides onto the job list **in memory**; `tick`, `status` and `run` all read through that one seam, so `status` cannot report something the scheduler will not do. `jobs.yml` is never rewritten.

**Tech Stack:** Node ESM (`.mjs`, zero runtime deps — js-yaml is vendored), vitest, existing `lib/cron.mjs` for cron validation.

## Global Constraints

- **Never halt the tick over a profile problem.** A missing/unreadable file or an unknown name behaves as "no profile" and the scheduler keeps running. Validation is strict only at `profile show` / `list` / `set`, where a human is present.
- **Never rewrite `jobs.yml`.** Overrides are applied in memory only.
- **Backwards compatible:** a `jobs.yml` with no `profiles:` key behaves exactly as today, including byte-for-byte identical `status --human` output and `status` JSON.
- Zero new runtime dependencies; no bare imports under `tools/` (plugins ship as a file copy).
- `.claude/CLAUDE.md` applies: implemented on Windows ⇒ the e2e suites also run under WSL, both platforms' numbers reported.
- No release tag or push without explicit confirmation.

---

### Task 1: `readJobs` / `writeJobs` must not destroy `profiles:`

`readJobs` returns only `{version, defaults, jobs}` and `setJob` writes back exactly what it read — so the first `set-job` after adding a `profiles:` block would silently delete it. The feature destroys its own table without this.

**Files:**
- Modify: `plugins/p-shed/tools/lib/io.mjs:22-31`
- Test: `plugins/p-shed/tools/__tests__/jobs.test.ts`

**Interfaces:**
- Produces: `readJobs(root)` → `{ version, defaults, jobs, profiles }` (`profiles` defaults to `{}`); `writeJobs` persists `profiles` only when non-empty.

- [ ] **Step 1: Write the failing test**

```ts
it('set-job preserves a profiles: block instead of silently deleting it', () => {
  writeJobs(root, {
    version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', prompt: 'go' }],
    profiles: { eco: { a: { schedule: '0 */3 * * *' } } },
  });
  setJob(root, { id: 'a', schedule: '*/5 * * * *' });
  expect(readJobs(root).profiles).toEqual({ eco: { a: { schedule: '0 */3 * * *' } } });
});

it('readJobs reports an absent profiles: block as {}', () => {
  writeJobs(root, { version: 1, defaults: {}, jobs: [] });
  expect(readJobs(root).profiles).toEqual({});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/jobs.test.ts`
Expected: FAIL — `profiles` is `undefined` after the round trip.

- [ ] **Step 3: Implement**

```js
export function readJobs(root) {
  const p = paths(root).jobs;
  if (!existsSync(p)) return { version: 1, defaults: {}, jobs: [], profiles: {} };
  const data = yaml.load(readFileSync(p, 'utf-8')) || {};
  return { version: data.version ?? 1, defaults: data.defaults ?? {}, jobs: data.jobs ?? [], profiles: data.profiles ?? {} };
}

export function writeJobs(root, data) {
  // Round-trip the profiles table. setJob/rmJob write back exactly what readJobs
  // returned, so a key dropped here is a key deleted from the operator's file.
  const { profiles, ...rest } = data;
  const out = profiles && Object.keys(profiles).length ? { ...rest, profiles } : rest;
  writeFile(paths(root).jobs, yaml.dump(out));
}
```

- [ ] **Step 4: Run the whole p-shed suite**

Run: `npx vitest run plugins/p-shed`
Expected: PASS (the new tests included).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/io.mjs plugins/p-shed/tools/__tests__/jobs.test.ts
git commit -m "fix(p-shed): carry jobs.yml's profiles: block through readJobs/writeJobs"
```

---

### Task 2: One copy of the field-validation rules

`setJob` owns "which efforts exist" and "does this cron parse". The profile table needs the same answers; a second copy is how they drift.

**Files:**
- Modify: `plugins/p-shed/tools/lib/jobs.mjs:6,32-37`
- Test: `plugins/p-shed/tools/__tests__/jobs.test.ts`

**Interfaces:**
- Produces: `EFFORT_LEVELS: string[]`, `jobFieldError(field, value) → string | null` (null = valid). Fields understood: `schedule`, `model`, `effort`, `timeoutSec`, `enabled`; any other field returns `null`.

- [ ] **Step 1: Write the failing test**

```ts
import { jobFieldError, EFFORT_LEVELS } from '../lib/jobs.mjs';

describe('jobFieldError', () => {
  it('accepts valid values', () => {
    expect(jobFieldError('schedule', '*/5 * * * *')).toBeNull();
    expect(jobFieldError('effort', 'high')).toBeNull();
    expect(jobFieldError('timeoutSec', 60)).toBeNull();
    expect(jobFieldError('enabled', false)).toBeNull();
    expect(jobFieldError('model', 'sonnet')).toBeNull();
  });
  it('rejects invalid ones with setJob-identical wording', () => {
    expect(jobFieldError('effort', 'turbo')).toBe(`invalid effort: turbo (expected one of ${EFFORT_LEVELS.join(', ')})`);
    expect(jobFieldError('schedule', 'nope')).toMatch(/^invalid cron: /);
    expect(jobFieldError('timeoutSec', 0)).toMatch(/^invalid timeoutSec: /);
    expect(jobFieldError('enabled', 'yes')).toMatch(/^invalid enabled: /);
  });
  it('ignores fields it does not own', () => {
    expect(jobFieldError('prompt', 42)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/jobs.test.ts`
Expected: FAIL — `jobFieldError is not a function`.

- [ ] **Step 3: Implement, and route `setJob` through it**

```js
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

// One definition of "is this a legal value for this job field", shared by setJob and the
// profiles table. Returns a message or null. Two copies of these rules is how `set-job`
// and a profile override end up disagreeing about what `effort: turbo` means.
export function jobFieldError(field, value) {
  switch (field) {
    case 'schedule':
      try { parseCron(value); return null; } catch (e) { return `invalid cron: ${e.message}`; }
    case 'effort':
      return EFFORT_LEVELS.includes(value) ? null : `invalid effort: ${value} (expected one of ${EFFORT_LEVELS.join(', ')})`;
    case 'timeoutSec':
      return Number.isFinite(value) && value > 0 ? null : `invalid timeoutSec: ${value} (expected a positive number)`;
    case 'enabled':
      return typeof value === 'boolean' ? null : `invalid enabled: ${value} (expected true or false)`;
    case 'model':
      return typeof value === 'string' && value.length > 0 ? null : `invalid model: ${value} (expected a name)`;
    default:
      return null;
  }
}
```

In `setJob`, replace the inline cron try/catch and the effort check:

```js
  const schedule = spec.schedule ?? existing.schedule;
  const scheduleErr = jobFieldError('schedule', schedule);
  if (scheduleErr) throw new ValidationError(scheduleErr);

  if (spec.effort !== undefined) {
    const effortErr = jobFieldError('effort', spec.effort);
    if (effortErr) throw new ValidationError(effortErr);
  }
```

- [ ] **Step 4: Run the suite — `setJob`'s messages must be unchanged**

Run: `npx vitest run plugins/p-shed`
Expected: PASS, including the pre-existing `set-job` validation tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/jobs.mjs plugins/p-shed/tools/__tests__/jobs.test.ts
git commit -m "refactor(p-shed): extract jobFieldError so profiles reuse set-job's rules"
```

---

### Task 3: `lib/profile.mjs` — resolve and apply

**Files:**
- Create: `plugins/p-shed/tools/lib/profile.mjs`
- Test: `plugins/p-shed/tools/__tests__/profile.test.ts`

**Interfaces:**
- Consumes: `jobFieldError`, `EFFORT_LEVELS`, `ValidationError` (Task 2).
- Produces:
  - `PROFILE_FIELDS = ['schedule', 'model', 'effort', 'timeoutSec', 'enabled']`
  - `readProfileValue(path) → string | null`
  - `profileFilePath(root, config) → string | null` (exported — Task 6's `profile set` needs the same resolution, and a second copy would be a second answer)
  - `resolveProfile({ root, jobsData, config, env }) → { name, source, file?, problem?, warning? }`
  - `applyProfile(jobs, profiles, name) → job[]`
  - `validateProfiles(profiles) → void` (throws `ValidationError`)
  - `effectiveJobs({ root, jobsData, config, env }) → { jobs, profile }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProfile, effectiveJobs, readProfileValue, resolveProfile, validateProfiles } from '../lib/profile.mjs';

const TABLE = { eco: { worker: { schedule: '0 */3 * * *' }, planner: { enabled: false } }, fast: { worker: { schedule: '0,30 * * * *' } } };
const JOBS = [
  { id: 'worker', schedule: '* * * * *', prompt: 'w', enabled: true, model: 'opus' },
  { id: 'planner', schedule: '0 6 * * *', prompt: 'p', enabled: true },
];
const data = (over = {}) => ({ version: 1, defaults: {}, jobs: JOBS, profiles: TABLE, ...over });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-profile-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveProfile precedence', () => {
  it('env wins over file and default', () => {
    const f = join(root, 'p'); writeFileSync(f, 'fast\n');
    const r = resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: f }, env: { PSHED_PROFILE: 'eco' } });
    expect(r).toMatchObject({ name: 'eco', source: 'env' });
  });
  it('file wins over default and names the file', () => {
    const f = join(root, 'p'); writeFileSync(f, 'fast\nignored second line\n');
    const r = resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: f }, env: {} });
    expect(r).toMatchObject({ name: 'fast', source: 'file', file: f });
  });
  it('falls back to defaults.profile', () => {
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: {}, env: {} }))
      .toMatchObject({ name: 'eco', source: 'default' });
  });
  it('resolves to none when nothing is configured', () => {
    expect(resolveProfile({ root, jobsData: data(), config: {}, env: {} })).toMatchObject({ name: null, source: 'none' });
  });
  it('treats an empty env var as unset', () => {
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: {}, env: { PSHED_PROFILE: '  ' } }))
      .toMatchObject({ name: 'eco', source: 'default' });
  });
  it('treats an empty file as no choice and falls through', () => {
    const f = join(root, 'p'); writeFileSync(f, '\n');
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: f }, env: {} }))
      .toMatchObject({ name: 'eco', source: 'default' });
  });
  it('warns but keeps running when the configured file is missing', () => {
    const r = resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: join(root, 'nope') }, env: {} });
    expect(r).toMatchObject({ name: 'eco', source: 'default', warning: 'file-missing' });
  });
  it('flags an unknown name as a problem, not as a valid profile', () => {
    const r = resolveProfile({ root, jobsData: data(), config: {}, env: { PSHED_PROFILE: 'turbo' } });
    expect(r).toMatchObject({ name: 'turbo', source: 'env', problem: 'unknown-name' });
  });
  it('resolves a relative profileFile against the root', () => {
    writeFileSync(join(root, 'rel'), 'fast\n');
    expect(resolveProfile({ root, jobsData: data(), config: { profileFile: 'rel' }, env: {} })).toMatchObject({ name: 'fast' });
  });
});

describe('readProfileValue', () => {
  it('reads the first line trimmed', () => {
    const f = join(root, 'p'); writeFileSync(f, '  eco  \nrest\n');
    expect(readProfileValue(f)).toBe('eco');
  });
  it('returns null for a missing file instead of throwing', () => {
    expect(readProfileValue(join(root, 'nope'))).toBeNull();
  });
});

describe('applyProfile', () => {
  it('layers the override over the job and leaves the rest alone', () => {
    const out = applyProfile(JOBS, TABLE, 'eco');
    expect(out[0]).toMatchObject({ id: 'worker', schedule: '0 */3 * * *', model: 'opus', prompt: 'w' });
    expect(out[1]).toMatchObject({ id: 'planner', enabled: false, schedule: '0 6 * * *' });
  });
  it('never mutates the input jobs', () => {
    applyProfile(JOBS, TABLE, 'eco');
    expect(JOBS[0].schedule).toBe('* * * * *');
  });
  it('ignores a profile entry for a job that does not exist', () => {
    expect(applyProfile(JOBS, { eco: { ghost: { enabled: false } } }, 'eco').map(j => j.id)).toEqual(['worker', 'planner']);
  });
  it('drops an invalid override instead of halting, keeping the job base value', () => {
    const out = applyProfile(JOBS, { eco: { worker: { schedule: 'nope', effort: 'turbo', model: 'sonnet' } } }, 'eco');
    expect(out[0].schedule).toBe('* * * * *');
    expect(out[0].effort).toBeUndefined();
    expect(out[0].model).toBe('sonnet');
  });
  it('ignores unknown keys in an override', () => {
    const out = applyProfile(JOBS, { eco: { worker: { prompt: 'hijacked' } } }, 'eco');
    expect(out[0].prompt).toBe('w');
  });
  it('returns the jobs untouched for an unknown or null name', () => {
    expect(applyProfile(JOBS, TABLE, 'turbo')).toEqual(JOBS);
    expect(applyProfile(JOBS, TABLE, null)).toEqual(JOBS);
  });
});

describe('validateProfiles', () => {
  it('accepts a well-formed table and an absent one', () => {
    expect(() => validateProfiles(TABLE)).not.toThrow();
    expect(() => validateProfiles(undefined)).not.toThrow();
  });
  it('names the profile, job and field of a bad value', () => {
    expect(() => validateProfiles({ eco: { worker: { effort: 'turbo' } } })).toThrow(/eco.*worker.*invalid effort/);
  });
  it('rejects an unknown override key', () => {
    expect(() => validateProfiles({ eco: { worker: { schedul: '* * * * *' } } })).toThrow(/schedul/);
  });
  it('rejects a non-object profile entry', () => {
    expect(() => validateProfiles({ eco: 'nope' })).toThrow(/eco/);
  });
});

describe('effectiveJobs', () => {
  it('applies the resolved profile', () => {
    const { jobs, profile } = effectiveJobs({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: {}, env: {} });
    expect(profile).toMatchObject({ name: 'eco', source: 'default' });
    expect(jobs[0].schedule).toBe('0 */3 * * *');
  });
  it('applies nothing when the name is unknown, and still returns every job', () => {
    const { jobs, profile } = effectiveJobs({ root, jobsData: data(), config: {}, env: { PSHED_PROFILE: 'turbo' } });
    expect(profile.problem).toBe('unknown-name');
    expect(jobs).toEqual(JOBS);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/profile.test.ts`
Expected: FAIL — cannot resolve `../lib/profile.mjs`.

- [ ] **Step 3: Implement `lib/profile.mjs`**

```js
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ValidationError, jobFieldError } from './jobs.mjs';

// What a profile is allowed to change. Deliberately small: a profile is a PACE control,
// not a second place to define a job. `prompt`, `cwd`, `guard` and friends stay in
// jobs.yml, where a diff shows them.
export const PROFILE_FIELDS = ['schedule', 'model', 'effort', 'timeoutSec', 'enabled'];

// First line, trimmed. null for missing / unreadable / empty — never throws: the
// scheduler must not stop because a pace file is absent.
export function readProfileValue(path) {
  try {
    const first = readFileSync(path, 'utf-8').split('\n')[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

export function profileFilePath(root, config) {
  const p = config?.profileFile;
  if (typeof p !== 'string' || p.length === 0) return null;
  return isAbsolute(p) ? p : resolve(root, p);
}

// Which profile is active, and — just as important for an operator debugging "why is it
// still slow" — WHERE that answer came from.
//   PSHED_PROFILE -> config.profileFile's contents -> defaults.profile -> none
// `problem: 'unknown-name'` means the name resolved but the table has no such entry, so
// no overrides are applied. `warning: 'file-*'` means the configured file could not be
// read and resolution fell through; whatever that yields IS applied.
export function resolveProfile({ root, jobsData = {}, config = {}, env = process.env } = {}) {
  const table = jobsData.profiles ?? {};
  const decorate = (r) => (r.name && !Object.prototype.hasOwnProperty.call(table, r.name) ? { ...r, problem: 'unknown-name' } : r);

  const fromEnv = typeof env?.PSHED_PROFILE === 'string' ? env.PSHED_PROFILE.trim() : '';
  const file = profileFilePath(root, config);
  const base = file ? { file } : {};

  if (fromEnv) return decorate({ name: fromEnv, source: 'env', ...base });

  let warning;
  if (file) {
    if (!existsSync(file)) warning = 'file-missing';
    else {
      const value = readProfileValue(file);
      if (value) return decorate({ name: value, source: 'file', ...base });
      // Readable but empty is a legitimate "no choice yet" — fall through. Unreadable is
      // a setup problem worth reporting, and also falls through rather than halting.
      try { readFileSync(file, 'utf-8'); } catch { warning = 'file-unreadable'; }
    }
  }

  const fromDefaults = typeof jobsData.defaults?.profile === 'string' ? jobsData.defaults.profile.trim() : '';
  if (fromDefaults) return decorate({ name: fromDefaults, source: 'default', ...base, ...(warning ? { warning } : {}) });
  return { name: null, source: 'none', ...base, ...(warning ? { warning } : {}) };
}

// Layer a profile's per-job overrides on top of the jobs, IN MEMORY. jobs.yml is never
// rewritten: it lives in the repository the loop commits to, so a rewrite would
// eventually be committed by the loop as if the pace change were its own work.
export function applyProfile(jobs, profiles, name) {
  const entry = name ? profiles?.[name] : null;
  if (!entry || typeof entry !== 'object') return jobs;
  return jobs.map((job) => {
    const over = entry[job.id];
    if (!over || typeof over !== 'object') return job;
    const patch = {};
    for (const field of PROFILE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(over, field)) continue;
      // Lenient on purpose: this path runs inside the tick, and one bad value must cost
      // that field, not the loop. The human-facing commands validate loudly instead.
      if (jobFieldError(field, over[field]) === null) patch[field] = over[field];
    }
    return Object.keys(patch).length ? { ...job, ...patch } : job;
  });
}

// Strict counterpart of applyProfile, for the surfaces where a human is watching.
export function validateProfiles(profiles) {
  if (profiles == null) return;
  if (typeof profiles !== 'object' || Array.isArray(profiles)) throw new ValidationError('profiles must be a map of profile name -> job id -> overrides');
  for (const [name, entry] of Object.entries(profiles)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ValidationError(`profile ${name}: expected a map of job id -> overrides`);
    for (const [jobId, over] of Object.entries(entry)) {
      if (!over || typeof over !== 'object' || Array.isArray(over)) throw new ValidationError(`profile ${name}, job ${jobId}: expected a map of field -> value`);
      for (const [field, value] of Object.entries(over)) {
        if (!PROFILE_FIELDS.includes(field)) {
          throw new ValidationError(`profile ${name}, job ${jobId}: unknown field ${field} (expected one of ${PROFILE_FIELDS.join(', ')})`);
        }
        const err = jobFieldError(field, value);
        if (err) throw new ValidationError(`profile ${name}, job ${jobId}: ${err}`);
      }
    }
  }
}

// The single seam tick / status / run read through, so status can never report a value
// the scheduler will not act on.
export function effectiveJobs({ root, jobsData = {}, config = {}, env = process.env } = {}) {
  const profile = resolveProfile({ root, jobsData, config, env });
  const jobs = jobsData.jobs ?? [];
  return {
    jobs: profile.name && !profile.problem ? applyProfile(jobs, jobsData.profiles ?? {}, profile.name) : jobs,
    profile,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run plugins/p-shed/tools/__tests__/profile.test.ts`
Expected: PASS (30+ assertions).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/profile.mjs plugins/p-shed/tools/__tests__/profile.test.ts
git commit -m "feat(p-shed): resolve and apply speed profiles (lib/profile.mjs)"
```

---

### Task 4: The tick schedules on effective values

**Files:**
- Modify: `plugins/p-shed/tools/lib/tick.mjs:47-51`
- Test: `plugins/p-shed/tools/__tests__/tick-profile.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveJobs` (Task 3).
- Produces: no change to `tick`'s return shape — existing result arrays stay byte-identical.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeJobState, paths } from '../lib/io.mjs';

const MIN = 60000;
const NOW = new Date(2026, 6, 29, 9, 0).getTime();

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-tickprofile-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (o: Record<string, unknown> = {}) => ({
  runJob: vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 1, out: '', err: '' })),
  appendLog: vi.fn(), rotateLogs: vi.fn(), isPidAlive: vi.fn(() => false), writePid: vi.fn(), removePid: vi.fn(), ...o,
});
const jobs = (profiles: unknown, defaults: Record<string, unknown> = {}) => writeJobs(root, {
  version: 1, defaults, profiles,
  jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }],
});
const writeConfig = (cfg: Record<string, unknown>) => {
  mkdirSync(paths(root).dir, { recursive: true });
  writeFileSync(paths(root).config, JSON.stringify(cfg), 'utf-8');
};

describe('tick + profiles', () => {
  it('computes due-ness from the profile schedule, not the job schedule', async () => {
    jobs({ eco: { a: { schedule: '0 */3 * * *' } } }, { profile: 'eco' });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const d = deps();
    expect(await tick({ root, now: NOW, deps: d })).toEqual([{ id: 'a', action: 'not-due' }]);
    expect(d.runJob).not.toHaveBeenCalled();
  });

  it('an override of enabled: false suppresses the launch', async () => {
    jobs({ eco: { a: { enabled: false } } }, { profile: 'eco' });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const d = deps();
    expect(await tick({ root, now: NOW, deps: d })).toEqual([]);
    expect(d.runJob).not.toHaveBeenCalled();
  });

  it('passes the profile model/timeoutSec through to the launch', async () => {
    jobs({ eco: { a: { model: 'sonnet', timeoutSec: 90 } } }, { profile: 'eco' });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect((d.runJob as any).mock.calls[0][0].job).toMatchObject({ model: 'sonnet', timeoutSec: 90 });
  });

  it('PSHED_PROFILE overrides defaults.profile at tick time', async () => {
    jobs({ eco: { a: { enabled: false } }, fast: { a: { schedule: '* * * * *' } } }, { profile: 'eco' });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const prev = process.env.PSHED_PROFILE;
    process.env.PSHED_PROFILE = 'fast';
    try {
      const d = deps();
      await tick({ root, now: NOW, deps: d });
      expect(d.runJob).toHaveBeenCalledOnce();
    } finally { if (prev === undefined) delete process.env.PSHED_PROFILE; else process.env.PSHED_PROFILE = prev; }
  });

  it('an unknown profile name still ticks, at the job\'s own pace', async () => {
    jobs({ eco: { a: { enabled: false } } }, { profile: 'turbo' });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect(d.runJob).toHaveBeenCalledOnce();
  });

  it('a profileFile pointing nowhere still ticks', async () => {
    jobs({ eco: { a: { enabled: false } } }, {});
    writeConfig({ profileFile: join(root, 'missing-profile') });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect(d.runJob).toHaveBeenCalledOnce();
  });

  it('an invalid override costs that field only', async () => {
    jobs({ eco: { a: { schedule: 'nonsense', model: 'sonnet' } } }, { profile: 'eco' });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect((d.runJob as any).mock.calls[0][0].job).toMatchObject({ schedule: '* * * * *', model: 'sonnet' });
  });

  it('never rewrites jobs.yml', async () => {
    jobs({ eco: { a: { schedule: '0 */3 * * *' } } }, { profile: 'eco' });
    const before = readFileSync(paths(root).jobs, 'utf-8');
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    await tick({ root, now: NOW, deps: deps() });
    expect(readFileSync(paths(root).jobs, 'utf-8')).toBe(before);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/tick-profile.test.ts`
Expected: FAIL — the job launches on its own schedule; profiles are ignored.

- [ ] **Step 3: Implement**

In `lib/tick.mjs`, import `effectiveJobs` and replace the jobs/config read:

```js
  const jobsData = d.readJobs(root);
  const config = d.readConfig(root);
  // Speed profile: an operator-owned pace whose ACTIVE value can live outside this
  // repository. Overrides are layered in memory only — see lib/profile.mjs.
  const { defaults } = jobsData;
  const { jobs } = effectiveJobs({ root, jobsData, config });
  const results = [...preamble];
```

- [ ] **Step 4: Run the p-shed suite**

Run: `npx vitest run plugins/p-shed`
Expected: PASS — the existing `tick.test.ts` / `tick-guard.test.ts` are untouched.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/tick.mjs plugins/p-shed/tools/__tests__/tick-profile.test.ts
git commit -m "feat(p-shed): schedule from profile-effective job values"
```

---

### Task 5: `status` and `run` read the same effective values

**Files:**
- Modify: `plugins/p-shed/tools/lib/status.mjs:10-14,50-66,71-81`
- Modify: `plugins/p-shed/tools/pshed.mjs` (the `run` command's `readJobs` call)
- Test: `plugins/p-shed/tools/__tests__/status-profile.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveJobs` (Task 3).
- Produces: `collectStatus` gains an optional `profile` key (**omitted entirely** when no profile is configured and nothing is wrong, so today's JSON stays byte-identical); `formatHuman` gains a `profile:` header line under the same condition.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { collectStatus, formatHuman } from '../lib/status.mjs';

const JOBS = [
  { id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'w' },
  { id: 'planner', schedule: '0 6 * * *', enabled: true, prompt: 'p' },
];
const deps = (jobsData: Record<string, unknown>, config: Record<string, unknown> = {}) => ({
  readJobs: () => ({ version: 1, defaults: {}, jobs: JOBS, profiles: {}, ...jobsData }),
  readConfig: () => config,
  readJobState: () => ({ lastRun: 1 }),
  readPauseRecord: () => null,
  readGlobalPause: () => null,
  readPid: () => null,
  isPidAlive: () => false,
});

describe('status + profiles', () => {
  it('reports the EFFECTIVE enabled flag, not the raw one', () => {
    const s = collectStatus('/nowhere', { installed: false, deps: deps({ defaults: { profile: 'eco' }, profiles: { eco: { planner: { enabled: false } } } }) });
    expect(s.jobs.find((j: any) => j.id === 'planner').enabled).toBe(false);
    expect(s.profile).toMatchObject({ name: 'eco', source: 'default' });
  });

  it('shows the active profile and its source in the human header', () => {
    const s = collectStatus('/nowhere', { installed: false, deps: deps({ defaults: { profile: 'eco' }, profiles: { eco: {} } }) });
    expect(formatHuman(s, 1)).toMatch(/profile: {3}eco \(default\)/);
  });

  it('surfaces an unknown name instead of pretending it is active', () => {
    const s = collectStatus('/nowhere', { installed: false, deps: deps({ defaults: { profile: 'turbo' }, profiles: { eco: {} } }) });
    expect(s.profile).toMatchObject({ name: 'turbo', problem: 'unknown-name' });
    expect(formatHuman(s, 1)).toContain('unknown-name');
  });

  it('omits the profile entirely when none is configured (today\'s output, unchanged)', () => {
    const s = collectStatus('/nowhere', { installed: false, deps: deps({}) });
    expect(s.profile).toBeUndefined();
    expect(formatHuman(s, 1)).not.toContain('profile:');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/status-profile.test.ts`
Expected: FAIL — `s.profile` is undefined and `planner.enabled` is `true`.

- [ ] **Step 3: Implement**

`lib/status.mjs`:

```js
import { readJobs, readConfig, readJobState } from './io.mjs';
import { effectiveJobs } from './profile.mjs';
...
export function collectStatus(root, { installed = null, deps = {} } = {}) {
  const d = { readJobs, readConfig, readJobState, readPauseRecord, readGlobalPause, readPid, isPidAlive, ...deps };
  const jobsData = d.readJobs(root);
  // Effective, not raw: a profile that disables a job or changes its schedule would
  // otherwise make status report something the scheduler will not do.
  const { jobs, profile } = effectiveJobs({ root, jobsData, config: d.readConfig(root) });
  const gp = d.readGlobalPause(root);
  ...
  return {
    action: 'status',
    task: taskName(root),
    installed,
    // Omitted when there is nothing to say, so an installation with no profiles sees
    // byte-identical output to before the feature existed.
    ...(profile.name || profile.problem || profile.warning ? { profile } : {}),
    paused: gp != null,
    ...
  };
}
```

and in `formatHuman`, after the `installed:` line:

```js
  if (status.profile) {
    const p = status.profile;
    const flags = [p.problem, p.warning].filter(Boolean).join(', ');
    lines.push(`profile:   ${p.name ?? '-'} (${p.source}${p.file ? ` ${p.file}` : ''})${flags ? ` [${flags}]` : ''}`);
  }
```

`pshed.mjs`, in the `run` command:

```js
      const jobsData = readJobs(root);
      const { defaults } = jobsData;
      // Same effective values the tick would use — a manual run at eco pace must not
      // silently use the fast model.
      const { jobs } = effectiveJobs({ root, jobsData, config: readConfig(root) });
      const job = jobs.find((j) => j.id === id);
```

- [ ] **Step 4: Run the p-shed suite**

Run: `npx vitest run plugins/p-shed`
Expected: PASS, `status.test.ts` and `status-guard.test.ts` included.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/status.mjs plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/status-profile.test.ts
git commit -m "feat(p-shed): status and run report profile-effective values"
```

---

### Task 6: `pshed profile show | set | list`, docs, manifest

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs:111` (KNOWN) and the command dispatch
- Modify: `plugins/p-shed/README.md`, `plugins/p-shed/.claude-plugin/plugin.json`
- Test: `plugins/p-shed/tools/__tests__/cli-profile-e2e.test.ts` (create)

**Interfaces:**
- Consumes: `resolveProfile`, `validateProfiles`, `effectiveJobs`, `PROFILE_FIELDS`.
- Produces: CLI subcommands; `profile show` JSON `{ action:'profile', name, source, file?, problem?, warning?, known:[], jobs:[{id, changes:{field:{from,to}}}] }`.

- [ ] **Step 1: Write the failing e2e test**

```ts
// Real-CLI e2e for `pshed profile`. The hard requirement — the ACTIVE value lives
// outside the scheduled repo — is only provable by spawning the process and looking at
// where the bytes landed.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeJobs, paths } from '../lib/io.mjs';

vi.setConfig({ testTimeout: 30_000 });
const CLI = resolve(__dirname, '..', 'pshed.mjs');

function pshed(cwd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

let root: string; let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pshed-cliprofile-'));
  outside = mkdtempSync(join(tmpdir(), 'pshed-outside-'));
  writeJobs(root, {
    version: 1, defaults: {},
    jobs: [{ id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'go' }],
    profiles: { eco: { worker: { schedule: '0 */3 * * *' } }, fast: { worker: { schedule: '0,30 * * * *' } } },
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

const config = (cfg: Record<string, unknown>) => {
  mkdirSync(paths(root).dir, { recursive: true });
  writeFileSync(paths(root).config, JSON.stringify(cfg), 'utf-8');
};

describe('CLI E2E: pshed profile', () => {
  it('list names the defined profiles', () => {
    const r = pshed(root, ['profile', 'list']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).profiles.sort()).toEqual(['eco', 'fast']);
  });

  it('show reports none when nothing is configured', () => {
    expect(JSON.parse(pshed(root, ['profile', 'show']).stdout)).toMatchObject({ name: null, source: 'none' });
  });

  it('set writes the name OUTSIDE the repo and show reads it back', () => {
    const file = join(outside, 'profile');
    config({ profileFile: file });
    const before = readFileSync(paths(root).jobs, 'utf-8');

    const set = pshed(root, ['profile', 'set', 'eco']);
    expect(set.status).toBe(0);
    expect(readFileSync(file, 'utf-8').trim()).toBe('eco');
    expect(readFileSync(paths(root).jobs, 'utf-8')).toBe(before); // jobs.yml untouched

    const show = JSON.parse(pshed(root, ['profile', 'show']).stdout);
    expect(show).toMatchObject({ name: 'eco', source: 'file', file });
    expect(show.jobs[0].changes.schedule).toMatchObject({ from: '* * * * *', to: '0 */3 * * *' });
  });

  it('set refuses when no profileFile is configured, and writes nothing', () => {
    const r = pshed(root, ['profile', 'set', 'eco']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/profileFile/);
    expect(existsSync(join(outside, 'profile'))).toBe(false);
  });

  it('set refuses an unknown name and lists the known ones', () => {
    config({ profileFile: join(outside, 'profile') });
    const r = pshed(root, ['profile', 'set', 'turbo']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/eco/);
    expect(existsSync(join(outside, 'profile'))).toBe(false);
  });

  it('PSHED_PROFILE beats the file and show says so', () => {
    const file = join(outside, 'profile');
    config({ profileFile: file });
    pshed(root, ['profile', 'set', 'eco']);
    const show = JSON.parse(pshed(root, ['profile', 'show'], { PSHED_PROFILE: 'fast' }).stdout);
    expect(show).toMatchObject({ name: 'fast', source: 'env' });
  });

  it('show --human prints the source and the per-job resolution', () => {
    config({ profileFile: join(outside, 'profile') });
    pshed(root, ['profile', 'set', 'eco']);
    const out = pshed(root, ['profile', 'show', '--human']).stdout;
    expect(out).toContain('eco');
    expect(out).toContain('worker');
    expect(out).toContain('0 */3 * * *');
  });

  it('an invalid table fails the human-facing command with a precise message', () => {
    writeJobs(root, {
      version: 1, defaults: {}, jobs: [{ id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'go' }],
      profiles: { eco: { worker: { effort: 'turbo' } } },
    });
    const r = pshed(root, ['profile', 'list']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/eco.*worker.*invalid effort/);
  });

  it('status reports the active profile', () => {
    config({ profileFile: join(outside, 'profile') });
    pshed(root, ['profile', 'set', 'eco']);
    expect(JSON.parse(pshed(root, ['status']).stdout).profile).toMatchObject({ name: 'eco', source: 'file' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-profile-e2e.test.ts`
Expected: FAIL — `unknown command: profile`.

- [ ] **Step 3: Implement the command**

Add `'profile'` to `KNOWN`, and dispatch:

```js
    if (command === 'profile') {
      const sub = args._[0] ?? 'show';
      if (!['show', 'set', 'list'].includes(sub)) {
        return emitJson({ error: { code: 'validation', message: `profile: unknown subcommand ${sub} (expected show, set or list)` } }, 2);
      }
      const jobsData = readJobs(root);
      const config = readConfig(root);
      // Strict here — a human is reading the output. The tick stays lenient on purpose.
      validateProfiles(jobsData.profiles);
      const known = Object.keys(jobsData.profiles ?? {});

      if (sub === 'list') return emitJson({ action: 'profile-list', profiles: known }, 0);

      if (sub === 'set') {
        const name = args._[1];
        if (!name || name === true) return emitJson({ error: { code: 'validation', message: 'profile set <name> requires a name' } }, 2);
        if (!known.includes(name)) {
          return emitJson({ error: { code: 'validation', message: `no such profile: ${name} (known: ${known.join(', ') || 'none'})` } }, 2);
        }
        const file = profileFilePath(root, config);
        if (!file) {
          return emitJson({ error: { code: 'validation', message: 'no profileFile configured in .pshed/config.json — refusing to write the active profile inside the scheduled repository' } }, 2);
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${name}\n`, 'utf-8');
        return emitJson({ action: 'profile-set', name, file }, 0);
      }

      const profile = resolveProfile({ root, jobsData, config });
      const { jobs } = effectiveJobs({ root, jobsData, config });
      const rawById = new Map((jobsData.jobs ?? []).map((j) => [j.id, j]));
      const changed = jobs.map((j) => {
        const raw = rawById.get(j.id) ?? {};
        const changes = {};
        for (const f of PROFILE_FIELDS) if (raw[f] !== j[f]) changes[f] = { from: raw[f] ?? null, to: j[f] ?? null };
        return Object.keys(changes).length ? { id: j.id, changes } : null;
      }).filter(Boolean);

      const out = { action: 'profile', ...profile, known, jobs: changed };
      if (args.human) {
        const flags = [profile.problem, profile.warning].filter(Boolean).join(', ');
        const lines = [
          `profile:   ${profile.name ?? '-'} (${profile.source}${profile.file ? ` ${profile.file}` : ''})${flags ? ` [${flags}]` : ''}`,
          `known:     ${known.join(', ') || '-'}`,
          '',
          ['job', 'field', 'from', 'to'].join('\t'),
        ];
        for (const j of changed) for (const [f, c] of Object.entries(j.changes)) lines.push([j.id, f, String(c.from), String(c.to)].join('\t'));
        process.stdout.write(lines.join('\n') + '\n');
        return process.exit(0);
      }
      return emitJson(out, 0);
    }
```

`profileFilePath` is not exported by `lib/profile.mjs` in Task 3 — export it there (add it to the export list) rather than duplicating the resolve logic in the CLI. Import `mkdirSync`/`writeFileSync` from `node:fs` and `dirname` from `node:path` in `pshed.mjs` if not already imported.

- [ ] **Step 4: Run the e2e test, then the whole suite**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-profile-e2e.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Document and bump**

- `plugins/p-shed/README.md`: a `## Speed profiles` section — the table shape, the precedence list, the hard requirement (active value outside the repo), the three commands, and the "never halts the tick" rule. Add `profile` to the command table and `profiles` / `defaults.profile` / `profileFile` to the file-layout table.
- `plugins/p-shed/.claude-plugin/plugin.json`: extend `description` with the `profile` commands and the `profiles:` key. (The version is already `0.11.0`, an unreleased minor — it covers this change too.)

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed
git commit -m "feat(p-shed): pshed profile show/set/list"
```

---

## Verification

- `npx vitest run` on Windows — full suite green.
- The same suite under WSL (`.claude/CLAUDE.md`), both numbers reported: `describe.skipIf(win32)` tests are verified nowhere otherwise.
