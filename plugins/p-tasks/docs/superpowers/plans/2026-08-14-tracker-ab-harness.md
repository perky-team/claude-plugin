# Tracker A/B Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a measurement harness that answers one question with numbers — keep p-tasks, or move to beads?

**Architecture:** Three arms (`none`, `ptasks`, `beads`) each work on a fresh copy of one small polygon repository, ten fresh `claude -p` sessions per run, five runs per arm. After every session the harness copies the working tree and scores it against a hidden `node:test` suite the agent never sees. All metrics are pure functions over the recorded rows, so every number in the study is unit-tested.

**Tech Stack:** Node 24+, plain ESM `.mjs`, `node:test` for the polygon, vitest for the harness's own tests, no runtime dependencies anywhere.

**Spec:** `plugins/p-tasks/docs/superpowers/specs/2026-08-14-tracker-ab-harness-design.md`

## Global Constraints

- **Worktree.** All work happens in the `tracker-ab` worktree at `.claude/worktrees/tracker-ab`. Never `cd` to the main checkout — a p-graph measurement may be running there.
- **Node 24+.** The suite's floor. `node --test` TAP output and `node:sqlite` behaviour differ below it.
- **No bare runtime imports.** Everything new lives under `plugins/p-tasks/scripts/`, which `tests/p-tasks-packaging.test.ts` does not scan — but keep the rule anyway: only `node:*` imports and relative paths. Nothing under `plugins/p-tasks/tools/` changes in this plan.
- **Harness tests go in `plugins/p-tasks/tools/__tests__/*.test.ts`.** That is the only glob vitest picks up for this plugin (`vitest.config.ts`), and the packaging test skips `__tests__`. Name them `measure-*.test.ts` and import the code with a relative path such as `../../scripts/measure-tracker/metrics.mjs`.
- **The polygon has no dependencies.** No `package-lock.json`, no `node_modules`, no vitest. Visible and hidden tests both use `node:test`.
- **Hidden tests are flat.** Top-level `test('R3 …')` only, never subtests — the TAP parser reads unindented lines.
- **Every hidden test name starts with its requirement id** (`R1` … `R10`).
- **Simple English** in every file, comment and commit message. No Claude attribution in commits.
- **Windows is the dev platform, WSL decides.** After the last code task, run the whole suite under WSL as `.claude/CLAUDE.md` requires, and report both platforms.
- **Money is gated.** Tasks 10, 11 and 12 spend real dollars. Each one stops and asks before spending.

---

### Task 1: The polygon seed

**Files:**
- Create: `plugins/p-tasks/scripts/polygon/SPEC.md`
- Create: `plugins/p-tasks/scripts/polygon/package.json`
- Create: `plugins/p-tasks/scripts/polygon/src/parse.js`, `src/schema.js`, `src/defaults.js`, `src/merge.js`, `src/flags.js`, `src/resolve.js`, `src/errors.js`, `src/report.js`
- Create: `plugins/p-tasks/scripts/polygon/bin/cli.js`
- Create: `plugins/p-tasks/scripts/polygon/tests/parse.test.js`, `tests/schema.test.js`, `tests/flags.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the ten requirements `R1`…`R10` and the exact module paths and export names every later task depends on.

The polygon is a config resolver: read an INI-like file, lay CLI flags over it, fill defaults, validate, print. Every requirement is pure — no clock, no network, no randomness — and each later one needs the earlier ones.

- [ ] **Step 1: Write `SPEC.md` with the interfaces pinned**

This file is the whole job description the agent ever gets. It must pin module paths and signatures, or the hidden suite fails on import errors and the study measures nothing.

````markdown
# Feature: a config resolver

Build a small library and a CLI that reads a config file, lays command-line
flags over it, fills in defaults, checks it against a schema, and prints the
result.

Ten requirements. Each names the file it lives in and the exact names it must
export. **Keep those paths and names exactly as written** — other code imports
them.

## R1 — parse an INI file

`src/parse.js` exports `parseIni(text)`.

Returns a plain object: section name to an object of key to string value.
Lines are `[section]`, `key = value`, blank, or `# comment`.
Keys outside any section go in the section `""`.
On any other line, throw a `SyntaxError` whose message is `line <n>: <the line>`,
counting from 1.

```js
parseIni('[a]\nx = 1\n')   // { a: { x: '1' } }
```

## R2 — check a value against a schema

`src/schema.js` exports `validate(config, schema)`.

A schema is `{ '<section>.<key>': { type, required, default } }` where `type` is
`'string'`, `'number'` or `'boolean'`.

Returns `{ ok: true, value }` where `value` has numbers and booleans converted,
or `{ ok: false, errors }` where each error is `{ path, message }`.

Messages, exactly:
- missing and required: `is required`
- not a number: `must be a number`
- not a boolean: `must be true or false`

`'true'` and `'false'` are the only booleans. A number is anything
`Number.isFinite` accepts after `Number(value)`, and an empty string is not one.
Errors come back sorted by `path`.

`value` holds only the paths the schema names. A key the schema does not name is
left out.

## R3 — fill in defaults

`src/defaults.js` exports `applyDefaults(config, schema)`.

Returns a new config with every schema path that has a `default` and no value
filled in. Never changes the input. Runs before validation, so a default of `1`
for a number path is written as the string `'1'`.

## R4 — merge layers

`src/merge.js` exports `mergeLayers(layers)`.

Takes an array of configs and merges them section by section, later layers
winning key by key. Never changes the inputs.

## R5 — parse command-line flags

`src/flags.js` exports `parseFlags(argv)`.

Returns `{ set, rest }`. `set` is a config in the same shape `parseIni` returns.
- `--section.key=value` sets that key.
- `--section.key value` does the same.
- `--flag` on its own sets `flag` in section `""` to `'true'`.
- Anything else goes to `rest`, in order.

## R6 — resolve everything

`src/resolve.js` exports `resolve({ text, argv, schema })`.

The whole pipeline: parse the text (R1), parse the flags (R5), merge with flags
last (R4), apply defaults (R3), validate (R2). Returns exactly what `validate`
returns.

## R7 — format errors

`src/errors.js` exports `formatErrors(errors)`.

Returns one line per error, `<path>: <message>`, joined by `\n`, in the order
given. An empty array gives an empty string.

## R8 — print as JSON

`src/report.js` exports `toJson(value)`.

`JSON.stringify` with two-space indent, and **keys sorted** at every level, so
the same config always prints the same bytes. No trailing newline.

## R9 — CLI exit codes

`bin/cli.js` reads a config path as its first argument and flags after it.

It always validates against this fixed schema, whatever the config holds:

| path | type | required | default |
|---|---|---|---|
| `server.port` | number | yes | — |
| `server.host` | string | no | `localhost` |
| `server.debug` | boolean | no | `false` |

| exit | when |
|---|---|
| 0 | resolved and valid |
| 2 | the file could not be parsed (R1 threw) |
| 3 | validation failed |
| 64 | no config path given |

On 2 and 3 it prints the message to stderr — the `SyntaxError` message for 2,
`formatErrors` output for 3.

## R10 — `--json`

With `--json` anywhere in the arguments, a successful run prints `toJson` of the
resolved value to stdout and nothing else. `--json` is not a config key and
never appears in the result.
````

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "polygon-config-resolver",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 3: Write the eight `src/` stubs and `bin/cli.js`**

Every stub exports the right name and throws, so the interface is visible and no
test passes by accident. All eight follow this shape:

```js
// src/parse.js
export function parseIni(text) {
  throw new Error('not implemented');
}
```

Repeat for `validate` in `src/schema.js`, `applyDefaults` in `src/defaults.js`,
`mergeLayers` in `src/merge.js`, `parseFlags` in `src/flags.js`, `resolve` in
`src/resolve.js`, `formatErrors` in `src/errors.js`, `toJson` in
`src/report.js`.

```js
// bin/cli.js
#!/usr/bin/env node
process.exit(64);
```

- [ ] **Step 4: Write the three visible tests**

These show the agent the house style and cover three of the ten requirements —
R1, R2 and R5. The other seven are checked only by the hidden suite.

```js
// tests/parse.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIni } from '../src/parse.js';

test('reads a section and a key', () => {
  assert.deepEqual(parseIni('[a]\nx = 1\n'), { a: { x: '1' } });
});

test('throws on a line it cannot read', () => {
  assert.throws(() => parseIni('[a]\n???\n'), { message: 'line 2: ???' });
});
```

```js
// tests/schema.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/schema.js';

test('converts a number', () => {
  const r = validate({ a: { x: '2' } }, { 'a.x': { type: 'number' } });
  assert.deepEqual(r, { ok: true, value: { a: { x: 2 } } });
});

test('reports a missing required key', () => {
  const r = validate({}, { 'a.x': { type: 'string', required: true } });
  assert.deepEqual(r, { ok: false, errors: [{ path: 'a.x', message: 'is required' }] });
});
```

```js
// tests/flags.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../src/flags.js';

test('reads --section.key=value', () => {
  assert.deepEqual(parseFlags(['--a.x=1']), { set: { a: { x: '1' } }, rest: [] });
});
```

- [ ] **Step 5: Run the visible suite and check it fails for the right reason**

Run: `node --test` from `plugins/p-tasks/scripts/polygon`
Expected: every test fails with `not implemented`. No import errors — an import
error here means a path in `SPEC.md` does not match a real file.

Bare `node --test`, with no path after it. `node --test tests/` looks right and
is not: Node 24 tries to load `tests` as a module and dies with
`MODULE_NOT_FOUND`, on Windows and Linux alike. Default discovery finds
`tests/*.test.js` on its own.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-tasks/scripts/polygon
git commit -m "test(p-tasks): add the polygon seed for the tracker A/B study"
```

---

### Task 2: The reference implementation and the hidden suite

**Files:**
- Create: `plugins/p-tasks/scripts/polygon-reference/src/*.js`, `bin/cli.js` (a full implementation of R1–R10)
- Create: `plugins/p-tasks/scripts/polygon-acceptance/acceptance.test.js`
- Create: `plugins/p-tasks/tools/__tests__/measure-acceptance.test.ts`

**Interfaces:**
- Consumes: the ten requirements and module paths from Task 1.
- Produces: `acceptance.test.js`, whose test names are `R1 …` through `R10 …` — the TAP parser in Task 5 and the metrics in Task 3 both key on those ids.

A hidden suite nobody has watched go green is a guess, not ground truth. The
reference implementation exists to prove the suite is passable, and the gate in
Step 4 keeps it that way.

- [ ] **Step 1: Write the reference implementation**

A complete, plain implementation of all ten requirements, in the same paths
`SPEC.md` names. It is never given to an agent — it is the study's own control.
Write it from the spec text, before writing the hidden tests, so the tests check
the spec and not the implementation.

Two modules to set the style; the other six follow the same shape, each doing
exactly what its requirement says and nothing more.

```js
// plugins/p-tasks/scripts/polygon-reference/src/parse.js
export function parseIni(text) {
  const out = {};
  let section = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]; out[section] ??= {}; continue; }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!pair) throw new SyntaxError(`line ${i + 1}: ${lines[i].trim()}`);
    out[section] ??= {};
    out[section][pair[1].trim()] = pair[2].trim();
  }
  return out;
}
```

```js
// plugins/p-tasks/scripts/polygon-reference/src/schema.js
const asNumber = (v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function validate(config, schema) {
  const value = {};
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    const [section, key] = path.split('.');
    const raw = config[section]?.[key];
    if (raw === undefined) {
      if (rule.required) errors.push({ path, message: 'is required' });
      continue;
    }
    let out = raw;
    if (rule.type === 'number') {
      out = asNumber(raw);
      if (out === null) { errors.push({ path, message: 'must be a number' }); continue; }
    }
    if (rule.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') {
        errors.push({ path, message: 'must be true or false' });
        continue;
      }
      out = raw === 'true';
    }
    value[section] ??= {};
    value[section][key] = out;
  }
  // Not localeCompare: it reads the machine's locale, which is a fourth
  // environment dependency next to no clock, no network and no randomness.
  // The equality arm matters — a comparator that never returns 0 puts equal
  // paths in an arbitrary order.
  errors.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
```

- [ ] **Step 2: Write the hidden suite**

At least two tests per requirement, twenty or so in total. Flat tests only, no
subtests. Every name begins with the requirement id.

```js
// plugins/p-tasks/scripts/polygon-acceptance/acceptance.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
// The suite is copied into the ROOT of a snapshot before it runs, so every path
// here is `./`, never `../`. Getting this wrong makes every test fail on an
// import error and the whole study reads as "the agent built nothing".
import { parseIni } from './src/parse.js';
import { validate } from './src/schema.js';
import { applyDefaults } from './src/defaults.js';
import { mergeLayers } from './src/merge.js';
import { parseFlags } from './src/flags.js';
import { resolve } from './src/resolve.js';
import { formatErrors } from './src/errors.js';
import { toJson } from './src/report.js';

test('R1 keeps keys before any section under the empty name', () => {
  assert.deepEqual(parseIni('x = 1\n'), { '': { x: '1' } });
});

test('R1 counts the line number from one', () => {
  assert.throws(() => parseIni('# ok\n\n???\n'), { message: 'line 3: ???' });
});

test('R2 sorts errors by path', () => {
  const schema = { 'b.y': { type: 'number' }, 'a.x': { type: 'boolean' } };
  const r = validate({ a: { x: 'yes' }, b: { y: 'no' } }, schema);
  assert.deepEqual(r.errors.map((e) => e.path), ['a.x', 'b.y']);
});

test('R2 refuses an empty string as a number', () => {
  const r = validate({ a: { x: '' } }, { 'a.x': { type: 'number' } });
  assert.deepEqual(r.errors, [{ path: 'a.x', message: 'must be a number' }]);
});

test('R3 does not change its input', () => {
  const input = { a: {} };
  applyDefaults(input, { 'a.x': { type: 'string', default: 'd' } });
  assert.deepEqual(input, { a: {} });
});

test('R4 lets the later layer win key by key', () => {
  const out = mergeLayers([{ a: { x: '1', y: '2' } }, { a: { y: '3' } }]);
  assert.deepEqual(out, { a: { x: '1', y: '3' } });
});

test('R5 reads a flag and its value as two arguments', () => {
  assert.deepEqual(parseFlags(['--a.x', '1']), { set: { a: { x: '1' } }, rest: [] });
});

test('R5 puts everything else in rest, in order', () => {
  assert.deepEqual(parseFlags(['one', '--f', 'two']).rest, ['one', 'two']);
});

test('R6 lets a flag beat the file', () => {
  const r = resolve({
    text: '[a]\nx = 1\n', argv: ['--a.x=9'], schema: { 'a.x': { type: 'number' } },
  });
  assert.deepEqual(r, { ok: true, value: { a: { x: 9 } } });
});

test('R6 fills a default the file left out', () => {
  const r = resolve({
    text: '', argv: [], schema: { 'a.x': { type: 'number', default: 7 } },
  });
  assert.deepEqual(r, { ok: true, value: { a: { x: 7 } } });
});

test('R7 writes one line per error', () => {
  const out = formatErrors([{ path: 'a.x', message: 'is required' },
    { path: 'b.y', message: 'must be a number' }]);
  assert.equal(out, 'a.x: is required\nb.y: must be a number');
});

test('R8 sorts keys at every level', () => {
  assert.equal(toJson({ b: 1, a: { d: 2, c: 3 } }),
    '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}');
});
```

R9 and R10 are checked by spawning the CLI:

```js
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'cli.js');
const withFile = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'polygon-')), 'c.ini');
  writeFileSync(p, text);
  return p;
};
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });

test('R9 exits 64 when no config path is given', () => {
  assert.equal(run([]).status, 64);
});

test('R9 exits 2 on a file it cannot parse', () => {
  assert.equal(run([withFile('???\n')]).status, 2);
});

test('R10 prints only JSON with --json', () => {
  const r = run([withFile('[a]\nx = 1\n'), '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { a: { x: '1' } });
});
```

- [ ] **Step 3: Run the suite against the reference by hand**

```bash
cp plugins/p-tasks/scripts/polygon-acceptance/acceptance.test.js \
   plugins/p-tasks/scripts/polygon-reference/acceptance.test.js
node --test plugins/p-tasks/scripts/polygon-reference/acceptance.test.js
rm plugins/p-tasks/scripts/polygon-reference/acceptance.test.js
```

Expected: every test passes. A failing test here is a bug in the test or in the
reference — fix it now, not after $100 of runs.

- [ ] **Step 4: Write the gate that keeps this true**

```ts
// plugins/p-tasks/tools/__tests__/measure-acceptance.test.ts
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../../../tests/helpers';

const SCRIPTS = join(repoRoot(), 'plugins', 'p-tasks', 'scripts');
const ACCEPTANCE = join(SCRIPTS, 'polygon-acceptance', 'acceptance.test.js');

function passRate(projectDir: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'polygon-gate-'));
  try {
    cpSync(projectDir, dir, { recursive: true });
    cpSync(ACCEPTANCE, join(dir, 'acceptance.test.js'));
    const r = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', 'acceptance.test.js'],
      { cwd: dir, encoding: 'utf-8' });
    const out = r.stdout ?? '';
    const ok = [...out.matchAll(/^ok \d+ - R\d+/gm)].length;
    const notOk = [...out.matchAll(/^not ok \d+ - R\d+/gm)].length;
    expect(ok + notOk).toBeGreaterThan(0);
    return ok / (ok + notOk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the hidden suite is real ground truth', () => {
  it('passes completely against the reference implementation', () => {
    expect(passRate(join(SCRIPTS, 'polygon-reference'))).toBe(1);
  }, 60_000);

  it('mostly fails against the bare seed, so it discriminates', () => {
    expect(passRate(join(SCRIPTS, 'polygon'))).toBeLessThan(0.15);
  }, 60_000);
});
```

- [ ] **Step 5: Run the gate**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-acceptance.test.ts`
Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-tasks/scripts/polygon-reference plugins/p-tasks/scripts/polygon-acceptance plugins/p-tasks/tools/__tests__/measure-acceptance.test.ts
git commit -m "test(p-tasks): add the hidden acceptance suite and prove it is passable"
```

---

### Task 3: `metrics.mjs` — every number the study reports

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker/metrics.mjs`
- Create: `plugins/p-tasks/tools/__tests__/measure-metrics.test.ts`

**Interfaces:**
- Consumes: nothing. Pure functions over plain objects.
- Produces: `done(sessions)`, `sessionsToDone(sessions)`, `regressionRate(sessions)`, `churn(sessions)`, `capShare(sessions)`. Each takes the array of session rows for **one run**, in session order, and returns a number or `null`. A session row is:

```js
{
  arm: 'ptasks', run: 1, session: 3,
  cost_usd: 0.42, num_turns: 18, hit_cap: false, error: null,
  // One entry per hidden test, keyed by its full name. Always the same keys in
  // every session of the study — Task 5 fills a test that did not run as false.
  // null only when scoring itself failed.
  tests: { 'R1 keeps keys before any section under the empty name': true,
           'R2 sorts errors by path': false },
  changed_lines_from_prev: 120,
  changed_lines_from_seed: 300,
}
```

**One boolean per test, not per requirement.** Folding a requirement's tests
together with AND was the first design and it was worse: `done` could only move
in ten-point steps, R9 with seven tests was three times harder to turn green
than R8 with two, and a single over-strict test cost a whole requirement. Per
test, `done` has 36 steps and one thin test costs one of them. The requirement
id still leads every test name, so the write-up can group by it whenever that
reads better.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-tasks/tools/__tests__/measure-metrics.test.ts
import { describe, expect, it } from 'vitest';
import { done, sessionsToDone, regressionRate, churn, capShare }
  from '../../scripts/measure-tracker/metrics.mjs';

const row = (session: number, tests: Record<string, boolean> | null, extra = {}) =>
  ({ session, tests, cost_usd: 0.1, hit_cap: false, error: null,
     changed_lines_from_prev: 10, changed_lines_from_seed: 10 * session, ...extra });

describe('done', () => {
  it('is the share green in the last scored session', () => {
    expect(done([row(1, { R1: true, R2: false }), row(2, { R1: true, R2: true })])).toBe(1);
  });

  it('ignores sessions that never scored', () => {
    expect(done([row(1, { R1: true, R2: false }), row(2, null)])).toBe(0.5);
  });

  it('is null when nothing scored at all', () => {
    expect(done([row(1, null)])).toBeNull();
  });
});

describe('sessionsToDone', () => {
  it('is the first session where everything is green', () => {
    expect(sessionsToDone([row(1, { R1: false }), row(2, { R1: true }), row(3, { R1: true })]))
      .toBe(2);
  });

  it('is null when it never finished', () => {
    expect(sessionsToDone([row(1, { R1: false })])).toBeNull();
  });
});

describe('regressionRate', () => {
  it('counts green turning red, per hand-over', () => {
    const rows = [row(1, { R1: true, R2: true }), row(2, { R1: false, R2: true }),
      row(3, { R1: false, R2: false })];
    expect(regressionRate(rows)).toBeCloseTo(1);       // two regressions, two hand-overs
  });

  it('does not count red turning green', () => {
    expect(regressionRate([row(1, { R1: false }), row(2, { R1: true })])).toBe(0);
  });

  it('is null with fewer than two scored sessions', () => {
    expect(regressionRate([row(1, { R1: true })])).toBeNull();
  });

  it('is null when no two neighbouring sessions both scored', () => {
    // Two scored sessions, but not next to each other: there is no hand-over to
    // read. Unknown, not zero — a zero would enter the arm's mean as measured
    // evidence that nothing broke.
    const rows = [row(1, { R1: true }), row(2, null), row(3, { R1: false })];
    expect(regressionRate(rows)).toBeNull();
  });
});

describe('churn', () => {
  it('is one when every line was written once', () => {
    const rows = [row(1, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 })];
    expect(churn(rows)).toBe(1);
  });

  it('is three when the same lines were rewritten three times', () => {
    const rows = [
      row(1, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 }),
      row(2, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 }),
      row(3, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 }),
    ];
    expect(churn(rows)).toBe(3);
  });

  it('is null when the run changed nothing', () => {
    expect(churn([row(1, null, { changed_lines_from_prev: 0, changed_lines_from_seed: 0 })]))
      .toBeNull();
  });
});

describe('capShare', () => {
  it('is the share of sessions that hit the dollar cap', () => {
    expect(capShare([row(1, null), row(2, null, { hit_cap: true })])).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-metrics.test.ts`
Expected: FAIL — cannot resolve `../../scripts/measure-tracker/metrics.mjs`.

- [ ] **Step 3: Write `metrics.mjs`**

```js
// Every number this study publishes is computed here, from plain objects, with
// no file system and no spawning. That is deliberate: a wrong formula would be
// invisible in a $100 run and obvious in a unit test.

const scored = (sessions) => sessions.filter((s) => s.tests && Object.keys(s.tests).length);
const share = (tests) => {
  const ids = Object.keys(tests);
  return ids.filter((id) => tests[id]).length / ids.length;
};

/** Share of hidden tests green in the last session that scored. */
export function done(sessions) {
  const rows = scored(sessions);
  return rows.length ? share(rows.at(-1).tests) : null;
}

/** 1-based session where every hidden test was green for the first time. */
export function sessionsToDone(sessions) {
  for (const s of scored(sessions)) {
    if (share(s.tests) === 1) return s.session;
  }
  return null;
}

// A rate, not a count. A run that finished at session 4 had three hand-overs and
// one that ran all ten had nine; counting raw regressions would reward the fast
// arm twice, once for speed and once for reliability.
export function regressionRate(sessions) {
  let handovers = 0;
  let regressions = 0;
  for (let i = 1; i < sessions.length; i++) {
    const before = sessions[i - 1].tests;
    const after = sessions[i].tests;
    if (!before || !after) continue;
    handovers++;
    for (const id of Object.keys(before)) {
      if (before[id] && after[id] === false) regressions++;
    }
  }
  return handovers ? regressions / handovers : null;
}

/** Lines written across the run, over lines that survived into the result. */
export function churn(sessions) {
  const written = sessions.reduce((n, s) => n + (s.changed_lines_from_prev ?? 0), 0);
  const kept = sessions.at(-1)?.changed_lines_from_seed ?? 0;
  return kept ? written / kept : null;
}

/** Share of sessions stopped by the per-session dollar cap. */
export function capShare(sessions) {
  return sessions.length
    ? sessions.filter((s) => s.hit_cap).length / sessions.length
    : null;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-metrics.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker/metrics.mjs plugins/p-tasks/tools/__tests__/measure-metrics.test.ts
git commit -m "feat(p-tasks): add the pure metrics for the tracker A/B study"
```

---

### Task 4: `snapshot.mjs` — copy the tree, measure churn

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker/snapshot.mjs`
- Create: `plugins/p-tasks/tools/__tests__/measure-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `snapshot(srcDir, destDir)` returning the destination path, and `changedLines(dirA, dirB)` returning a number. Task 8 calls both.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-tasks/tools/__tests__/measure-snapshot.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, changedLines } from '../../scripts/measure-tracker/snapshot.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'snap-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const write = (dir: string, rel: string, text: string) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

describe('snapshot', () => {
  it('copies files and skips node_modules', () => {
    const src = join(root, 'src');
    write(src, 'a.js', 'one\n');
    write(src, 'node_modules/big/index.js', 'huge\n');
    const dest = snapshot(src, join(root, 'dest'));
    expect(existsSync(join(dest, 'a.js'))).toBe(true);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
  });

  it('copies .git, because the agent may have committed', () => {
    const src = join(root, 'src');
    write(src, '.git/HEAD', 'ref: refs/heads/main\n');
    const dest = snapshot(src, join(root, 'dest'));
    expect(existsSync(join(dest, '.git', 'HEAD'))).toBe(true);
  });
});

describe('changedLines', () => {
  it('is zero for two identical trees', () => {
    write(join(root, 'a'), 'f.js', 'one\ntwo\n');
    write(join(root, 'b'), 'f.js', 'one\ntwo\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(0);
  });

  it('counts a line changed in the middle once', () => {
    write(join(root, 'a'), 'f.js', 'one\ntwo\nthree\n');
    write(join(root, 'b'), 'f.js', 'one\nTWO\nthree\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(1);
  });

  it('counts every line of a new file', () => {
    write(join(root, 'a'), 'f.js', 'one\n');
    write(join(root, 'b'), 'f.js', 'one\n');
    write(join(root, 'b'), 'g.js', 'x\ny\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(2);
  });

  it('ignores .git, which changes for reasons that are not work', () => {
    write(join(root, 'a'), '.git/index', 'x\n');
    write(join(root, 'b'), '.git/index', 'y\nz\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `snapshot.mjs`**

```js
import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_COPY = new Set(['node_modules']);
// .git is copied as evidence but never counted as work: its index and objects
// change on every commit for reasons that have nothing to do with lines written.
const SKIP_COUNT = new Set(['node_modules', '.git']);
const TEXT = /\.(js|mjs|cjs|json|md|ya?ml|txt|ini)$/i;

// A file that ends with a newline splits into a trailing empty string. That is
// not a line anybody wrote, and counting it would make every new file one line
// longer than it is. Drop that one element and nothing else: a blank line in
// the middle IS a line somebody wrote, and dropping every empty string would
// hide the churn of adding and removing them.
const lines = (text) => {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
};

/** Copy a working tree. Returns the destination. */
export function snapshot(srcDir, destDir) {
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => !src.split(sep).some((part) => SKIP_COPY.has(part)),
  });
  return destDir;
}

function textFiles(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_COUNT.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name) && statSync(p).size < 1_000_000) {
        out.set(relative(dir, p).split(sep).join('/'), lines(readFileSync(p, 'utf-8')));
      }
    }
  };
  walk(dir);
  return out;
}

// Changed lines without a real diff library: strip the common head and tail,
// and call what is left changed. It over-counts a pure insertion in the middle
// and never under-counts, which is what a churn ratio needs.
function changed(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
         && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return Math.max(a.length, b.length) - head - tail;
}

/** Lines that differ between two trees. */
export function changedLines(dirA, dirB) {
  const a = textFiles(dirA);
  const b = textFiles(dirB);
  let total = 0;
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    total += changed(a.get(path), b.get(path));
  }
  return total;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-snapshot.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker/snapshot.mjs plugins/p-tasks/tools/__tests__/measure-snapshot.test.ts
git commit -m "feat(p-tasks): snapshot a working tree and measure churn between snapshots"
```

---

### Task 5: `score.mjs` — run the hidden suite, read TAP

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker/score.mjs`
- Create: `plugins/p-tasks/tools/__tests__/measure-score.test.ts`

**Interfaces:**
- Consumes: `acceptance.test.js` and `polygon-reference/` from Task 2, and a snapshot directory from Task 4.
- Produces three functions:
  - `parseTap(text)` → `{ '<full test name>': true|false }`, one entry per top-level TAP line.
  - `expectedTests({ referenceDir, acceptanceFile })` → the array of test names the suite has, taken from a run against the reference implementation. The reference is what "all green" means, so the list never drifts from the suite.
  - `scoreSnapshot({ snapshotDir, acceptanceFile, expected })` → an entry for **every** name in `expected`: what the run said, or `false` if the run never reached it. `null` only when the runner produced no TAP output at all.

A test that did not run is `false`, not missing. A crash after four passing
tests must not read as "four out of four" — the snapshot has not shown that the
other behaviours work, and that is exactly what `false` means here.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-tasks/tools/__tests__/measure-score.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTap, resultFrom, scoreSnapshot, expectedTests }
  from '../../scripts/measure-tracker/score.mjs';
import { repoRoot } from '../../../../tests/helpers';

describe('parseTap', () => {
  it('keys every test by its full name', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - R1 reads a section',
      'not ok 2 - R2 sorts errors by path',
    ].join('\n');
    expect(parseTap(tap)).toEqual({
      'R1 reads a section': true,
      'R2 sorts errors by path': false,
    });
  });

  it('ignores indented subtest lines', () => {
    expect(parseTap('    ok 1 - inner\nok 2 - outer\n')).toEqual({ outer: true });
  });

  it('is empty for output with no test lines', () => {
    expect(parseTap('TAP version 13\n')).toEqual({});
  });
});

// A tiny two-test suite stands in for the real one: the behaviour under test is
// the filling and the null case, not the polygon.
const fixture = (dir: string, body: string) => {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'parse.js'), body);
  const acceptance = join(dir, 'acceptance.test.js');
  writeFileSync(acceptance, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { parseIni } from './src/parse.js';",
    "test('R1 returns an object', () => { assert.deepEqual(parseIni(''), {}); });",
    "test('R2 is not done', () => { assert.equal(1, 2); });",
  ].join('\n'));
  return acceptance;
};

describe('scoreSnapshot', () => {
  it('reports what the run said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'score-'));
    try {
      const acceptance = fixture(dir, 'export const parseIni = () => ({});\n');
      expect(scoreSnapshot({
        snapshotDir: dir,
        acceptanceFile: acceptance,
        expected: ['R1 returns an object', 'R2 is not done'],
      })).toEqual({ 'R1 returns an object': true, 'R2 is not done': false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('counts a test that never ran as false, not as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'score-'));
    try {
      // An import error kills the runner before either test reports.
      const acceptance = fixture(dir, 'throw new Error("broken");\n');
      expect(scoreSnapshot({
        snapshotDir: dir,
        acceptanceFile: acceptance,
        expected: ['R1 returns an object', 'R2 is not done'],
      })).toEqual({ 'R1 returns an object': false, 'R2 is not done': false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('resultFrom', () => {
  it('is null when the runner produced no TAP at all', () => {
    expect(resultFrom('', ['R1 a'])).toBeNull();
    expect(resultFrom('spawn ENOENT\n', ['R1 a'])).toBeNull();
  });

  it('is null when the runner started but reported no test at all', () => {
    // A TAP header and nothing else: the suite file never produced a test.
    // Nothing here is a fact about the agent's code, so it must not be scored
    // as if every test had failed.
    expect(resultFrom('TAP version 13\n# tests 0\n', ['R1 a'])).toBeNull();
  });

  it('is all red, not null, when the runner started and reported nothing green', () => {
    expect(resultFrom('TAP version 13\nnot ok 1 - acceptance.test.js\n', ['R1 a', 'R2 b']))
      .toEqual({ 'R1 a': false, 'R2 b': false });
  });

  it('ignores a name the study did not ask for', () => {
    expect(resultFrom('TAP version 13\nok 1 - R9 stray\n', ['R1 a']))
      .toEqual({ 'R1 a': false });
  });
});

describe('expectedTests', () => {
  it('takes the list from the reference implementation, where all are green', () => {
    const scripts = join(repoRoot(), 'plugins', 'p-tasks', 'scripts');
    const names = expectedTests({
      referenceDir: join(scripts, 'polygon-reference'),
      acceptanceFile: join(scripts, 'polygon-acceptance', 'acceptance.test.js'),
    });
    expect(names.length).toBeGreaterThan(30);
    expect(names.every((n) => /^R\d+ /.test(n))).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-score.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `score.mjs`**

```js
import { spawnSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// One unindented TAP line per top-level test. Node indents subtests, which is
// why the hidden suite is required to be flat.
const LINE = /^(not )?ok \d+ - (.+?)\s*$/gm;

/** TAP text to { '<test name>': true|false }, one entry per top-level test. */
export function parseTap(text) {
  const out = {};
  for (const [, notOk, name] of text.matchAll(LINE)) out[name] = !notOk;
  return out;
}

// Per test, not per run. Without it, one hanging test hangs the whole runner
// until the spawn timeout kills it — and a killed runner makes Node collapse
// the entire file into one `not ok 1 - acceptance.test.js` line, throwing away
// the `ok` lines of every test that had already passed. That would score a
// snapshot 0 of 37 for a single infinite loop. Measured: with this flag a hang
// becomes one failed test and its neighbours still report `ok`.
//
// 3s is about a thousand times what these tests need, and 37 of them can all
// time out inside the spawn timeout below.
const TEST_TIMEOUT_MS = 3_000;
const RUN_TIMEOUT_MS = 180_000;

function runSuite(dir, acceptanceFile, timeoutMs) {
  const target = join(dir, 'acceptance.test.js');
  try {
    copyFileSync(acceptanceFile, target);
    const r = spawnSync(process.execPath,
      ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`, '--test-reporter=tap', 'acceptance.test.js'],
      { cwd: dir, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1 << 26 });
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  } finally {
    rmSync(target, { force: true });
  }
}

/**
 * Turn a run's output into one entry per expected test. Pure, so the rule that
 * decides "did not score" against "scored all red" can be tested directly —
 * the real thing needs a runner that fails to start, which no test can stage.
 */
export function resultFrom(output, expected) {
  // One rule: no test line, no score. A run that reported nothing about any
  // test tells us nothing about the code — that is a fault in the harness, and
  // calling it "all red" would blame the agent for it.
  //
  // Note what this does NOT catch, on purpose: a snapshot whose code breaks the
  // import still produces `not ok 1 - acceptance.test.js`. That is a test line,
  // so the run counts as scored and every expected test comes back red — which
  // is the honest answer, because nothing was shown to work.
  if (!/^(not )?ok \d+ - /m.test(output)) return null;
  const said = parseTap(output);
  return Object.fromEntries(expected.map((name) => [name, said[name] === true]));
}

/**
 * The test names the suite has, read from a run against the reference. The
 * reference is what "all green" means, so this list cannot drift from the
 * suite the way a hand-written manifest would.
 */
export function expectedTests({ referenceDir, acceptanceFile, timeoutMs = RUN_TIMEOUT_MS }) {
  return Object.keys(parseTap(runSuite(referenceDir, acceptanceFile, timeoutMs)));
}

/**
 * Copy the hidden suite into a snapshot, run it, read the result, remove it.
 * The agent's own directory is never given this file — only a snapshot copy is.
 *
 * Every expected test gets an entry. A test the run never reached is `false`:
 * a crash after four passes has not shown that the fifth behaviour works, and
 * dropping it would score that snapshot four out of four.
 */
export function scoreSnapshot({ snapshotDir, acceptanceFile, expected, timeoutMs = RUN_TIMEOUT_MS }) {
  return resultFrom(runSuite(snapshotDir, acceptanceFile, timeoutMs), expected);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-score.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker/score.mjs plugins/p-tasks/tools/__tests__/measure-score.test.ts
git commit -m "feat(p-tasks): score a snapshot against the hidden suite"
```

---

### Task 6: `arms.mjs` — install an arm, and refuse to start a broken one

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker/arms.mjs`
- Create: `plugins/p-tasks/scripts/beads-arm-rule.md`
- Create: `plugins/p-tasks/tools/__tests__/measure-arms.test.ts`

**Interfaces:**
- Consumes: `plugins/p-tasks/tools/ptasks.mjs` (run as a child process) and `plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl`.
- Produces: `OFF_SETTINGS` (a JSON string), `prepArm({ arm, dir, pluginDir })`, and `preflight(arm)`. Task 8 calls all three.

Both tracker arms write their rule to the polygon's root `CLAUDE.md`, on top of
whatever the product's own install does. p-graph's harness does the same. The
reason is not fidelity but fairness: if Claude Code does not pick a rule file up
from where the product puts it, the arm loses for a reason that has nothing to
do with the tracker, and the study cannot tell those two apart. The smoke
session in Task 10 is what proves the rule is actually visible.

- [ ] **Step 1: Write `beads-arm-rule.md`**

Keep it the same length and shape as p-tasks' own rule. A longer rule is a
bigger prompt, and prompt size is one of the things being measured.

```markdown
# beads

A task tracker is installed in this repo. Its data lives in `.beads/`.

Use the `bd` command:
- `bd create "<title>"` — add an issue
- `bd update <id> --status=<open|in_progress|closed>` — change one
- `bd dep add <child> <parent>` — say that one blocks another
- `bd ready` — list issues with no open blockers
- `bd list` — list everything with its status

`bd init` has already been run — do not run it again.
```

- [ ] **Step 2: Write the failing tests**

```ts
// plugins/p-tasks/tools/__tests__/measure-arms.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFF_SETTINGS, prepArm } from '../../scripts/measure-tracker/arms.mjs';
import { repoRoot } from '../../../../tests/helpers';

const PLUGIN = join(repoRoot(), 'plugins', 'p-tasks');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arm-'));
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('OFF_SETTINGS', () => {
  it('switches off every plugin that would otherwise join the none arm', () => {
    const parsed = JSON.parse(OFF_SETTINGS);
    expect(parsed.enabledPlugins['p-graph@perky.team']).toBe(false);
    expect(parsed.enabledPlugins['p-tasks@perky.team']).toBe(false);
    expect(parsed.enabledPlugins['p-wiki@perky.team']).toBe(false);
  });
});

describe('prepArm', () => {
  it('leaves the none arm with nothing any arm left behind', () => {
    // Seed all of it, not only CLAUDE.md: a run directory is reused between
    // arms, so `none` has to undo whatever the arm before it installed.
    writeFileSync(join(dir, 'CLAUDE.md'), 'stale\n');
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    mkdirSync(join(dir, '.beads'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    prepArm({ arm: 'none', dir, pluginDir: PLUGIN });
    for (const p of ['CLAUDE.md', 'docs/tasks', '.beads', '.claude']) {
      expect(existsSync(join(dir, p)), p).toBe(false);
    }
  });

  it('gives the ptasks arm a rule and an initialised tracker', () => {
    prepArm({ arm: 'ptasks', dir, pluginDir: PLUGIN });
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toContain('/p-tasks:next');
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);
  }, 30_000);

  // Ask git, do not re-read our own constant. The failure this guards against
  // is a file the tracker's installer writes that the exclude list does not
  // name — and a test that only greps the list it is validating can never see
  // that. This is the property the whole study rests on: the arms must differ
  // by the tracker and by nothing else.
  it('leaves git status clean after installing an arm', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '--quiet', '-m', 'seed'], { cwd: dir });

    prepArm({ arm: 'ptasks', dir, pluginDir: PLUGIN });

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  }, 30_000);
});
```

The `beads` arm is not unit-tested here — it needs the `bd` binary, and Task 10's
smoke session is what proves it works.

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-arms.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `arms.mjs`**

```js
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEADS_RULE = join(HERE, '..', 'beads-arm-rule.md');

// The operator's own machine has plugins switched on for every session. Left
// alone they would quietly join the `none` arm and void the comparison. Each
// arm gets back exactly one thing, through --plugin-dir or the bd binary.
// Every plugin in this marketplace, not just the ones we remember using. A
// plugin left on joins all three arms, which does not bias the comparison but
// does stop `none` from being a floor — and the list of what the operator has
// switched on is not ours to predict.
export const OFF_SETTINGS = JSON.stringify({
  enabledPlugins: Object.fromEntries([
    ...['p-graph', 'p-tasks', 'p-wiki', 'p-statusline', 'p-flow', 'p-shed', 'p-observe', 'p-chat']
      .map((n) => [`${n}@perky.team`, false]),
    ['gopls-lsp@claude-plugins-official', false],
  ]),
  language: 'English',
});

// One list, two uses. A path that an arm owns has to be both removed when the
// arm changes and hidden from `git status`; keeping two hand-written lists in
// step is a drift waiting to happen.
const ARM_FILES = ['CLAUDE.md', '.claude', 'docs/tasks', '.beads'];

// A dirty `git status` is a hint one arm would have and another would not, so
// every arm's own files are excluded the same way, whichever arm is running.
// A bare name in an exclude file matches a file or a directory of that name,
// so the same list serves both without any decoration.
const EXCLUDE = `${ARM_FILES.join('\n')}\n`;

const clean = (dir) => {
  for (const p of ARM_FILES) rmSync(join(dir, p), { recursive: true, force: true });
};

/** Install one arm into a fresh clone. Returns the directory. */
export function prepArm({ arm, dir, pluginDir }) {
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'exclude'), EXCLUDE);
  clean(dir);

  if (arm === 'none') return dir;

  if (arm === 'ptasks') {
    execFileSync(process.execPath, [join(pluginDir, 'tools', 'ptasks.mjs'), 'init'],
      { cwd: dir, encoding: 'utf-8' });
    const rule = readFileSync(
      join(pluginDir, 'skills', '_shared', 'templates', 'p-tasks.rule.md.tpl'), 'utf-8');
    writeFileSync(join(dir, 'CLAUDE.md'), rule);
    return dir;
  }

  if (arm === 'beads') {
    execFileSync('bd', ['init'], { cwd: dir, encoding: 'utf-8' });
    writeFileSync(join(dir, 'CLAUDE.md'), readFileSync(BEADS_RULE, 'utf-8'));
    return dir;
  }

  throw new Error(`unknown arm: ${arm}`);
}

/**
 * Fail before the first dollar, not on the third arm two hours in. A rival that
 * is half-installed answers nothing, and the row would read "beads lost" when
 * what lost was the setup.
 */
export function preflight(arm) {
  if (arm !== 'beads') return;
  if (!existsSync(BEADS_RULE)) throw new Error(`missing rule file: ${BEADS_RULE}`);

  // Not "is it on PATH" but "does it work here". On Windows a `bd` that
  // resolves to a `.cmd` shim is found by `where` and then fails to spawn,
  // because Node cannot start a batch file without a shell. Running the real
  // command in a scratch directory catches that, and every other broken
  // install, before the study spends its first dollar.
  const scratch = mkdtempSync(join(tmpdir(), 'beads-preflight-'));
  try {
    const r = spawnSync('bd', ['init'], { cwd: scratch, encoding: 'utf-8' });
    if (r.error || r.status !== 0) {
      throw new Error('the beads arm is not ready: `bd init` did not work.\n'
        + `  ${(r.error?.message ?? (r.stderr || '').trim()) || `exit ${r.status}`}\n`
        + 'Install beads and check `bd init` runs in an empty directory, then re-run.\n'
        + 'Running the arm without it measures the setup, not the tool.');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-arms.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker/arms.mjs plugins/p-tasks/scripts/beads-arm-rule.md plugins/p-tasks/tools/__tests__/measure-arms.test.ts
git commit -m "feat(p-tasks): install a measurement arm, and refuse to start a broken one"
```

---

### Task 7: `session.mjs` — run one session and record what it cost

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker/session.mjs`
- Create: `plugins/p-tasks/tools/__tests__/measure-session.test.ts`

**Interfaces:**
- Consumes: `OFF_SETTINGS` from Task 6.
- Produces: `PROMPT` (the one sentence every session gets) and `runSession({ dir, arm, pluginDir, settingsFile, capUsd, model, claudeBin })` returning `{ cost_usd, num_turns, usage, session_id, hit_cap, error }`.

- [ ] **Step 1: Write the failing tests**

The test replaces the CLI with a stub. Use a `.mjs` stub run through `node`, not
a `.bat` — `.claude/CLAUDE.md` records that batch stubs hide failures a shell
stub exposes, and a stub that behaves differently per platform would make this
test worthless on the platform that matters.

```ts
// plugins/p-tasks/tools/__tests__/measure-session.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT, runSession } from '../../scripts/measure-tracker/session.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const stub = (body: string) => {
  const p = join(dir, 'fake-claude.mjs');
  writeFileSync(p, body);
  return p;
};

describe('PROMPT', () => {
  it('says nothing about what has already been done', () => {
    expect(PROMPT).toBe('Continue the work on the feature described in SPEC.md.');
  });
});

describe('runSession', () => {
  it('records cost and turns from the CLI envelope', () => {
    const bin = stub(`process.stdout.write(JSON.stringify(
      { total_cost_usd: 0.42, num_turns: 7, session_id: 'abc' }));`);
    const r = runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' });
    expect(r.cost_usd).toBe(0.42);
    expect(r.num_turns).toBe(7);
    expect(r.session_id).toBe('abc');
    expect(r.error).toBeNull();
  });

  it('marks a session that spent its whole cap', () => {
    const bin = stub(`process.stdout.write(JSON.stringify({ total_cost_usd: 4.95 }));`);
    expect(runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' }).hit_cap)
      .toBe(true);
  });

  it('records an error instead of throwing when the CLI writes nothing', () => {
    const bin = stub(`process.exit(1);`);
    const r = runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' });
    expect(r.error).toMatch(/exited 1/);
    expect(r.cost_usd).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `session.mjs`**

```js
import { spawnSync } from 'node:child_process';

// The same sentence in every session and every arm. It must not hint at what
// has already been done — remembering that is the tracker's job, and telling
// the agent would hand the `none` arm the very thing it is missing.
export const PROMPT = 'Continue the work on the feature described in SPEC.md.';

// A session that spends its whole cap was stopped by the cap, not by finishing.
// The CLI does not say so in its envelope, so read it from the money: anything
// within 2% of the cap was cut off.
const CAP_MARGIN = 0.98;

/**
 * Run one session in `dir`. Never throws — a failed session is a recorded row,
 * because losing 40 good sessions to one API hiccup is not acceptable.
 */
export function runSession({
  dir, arm, pluginDir, settingsFile, capUsd = 5, model = 'sonnet', claudeBin, runner,
}) {
  const args = ['-p', '--output-format', 'json', '--model', model,
    '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(capUsd)];
  if (settingsFile) args.push('--settings', settingsFile);
  if (arm === 'ptasks' && pluginDir) args.push('--plugin-dir', pluginDir);

  const [cmd, pre] = runner ? [runner, [claudeBin]] : [claudeBin, []];
  const r = spawnSync(cmd, [...pre, ...args], {
    cwd: dir, encoding: 'utf-8', maxBuffer: 1 << 28, input: PROMPT,
  });

  const blank = { cost_usd: null, num_turns: null, usage: null, session_id: null, hit_cap: false };
  if (r.error) return { ...blank, error: String(r.error.message) };
  if (!r.stdout) return { ...blank, error: `claude exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}` };

  let out;
  try { out = JSON.parse(r.stdout); }
  catch { return { ...blank, error: `unreadable output: ${r.stdout.slice(0, 200)}` }; }

  const cost = out.total_cost_usd ?? null;
  return {
    cost_usd: cost,
    num_turns: out.num_turns ?? null,
    usage: out.usage ?? null,
    session_id: out.session_id ?? null,
    hit_cap: cost !== null && cost >= capUsd * CAP_MARGIN,
    error: null,
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-session.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker/session.mjs plugins/p-tasks/tools/__tests__/measure-session.test.ts
git commit -m "feat(p-tasks): run one measured session and record what it cost"
```

---

### Task 8: `measure-tracker.mjs` — the CLI that runs the study

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker.mjs`
- Create: `plugins/p-tasks/tools/__tests__/measure-queue.test.ts`

**Interfaces:**
- Consumes: `prepArm`, `preflight`, `OFF_SETTINGS` (Task 6); `runSession`, `PROMPT` (Task 7); `snapshot`, `changedLines` (Task 4); `scoreSnapshot` (Task 5).
- Produces: `pendingWork(rows, { arms, runs })` — the only part of the CLI with logic worth testing — and the executable itself.

- [ ] **Step 1: Write the failing test for the queue**

```ts
// plugins/p-tasks/tools/__tests__/measure-queue.test.ts
import { describe, expect, it } from 'vitest';
import { pendingWork } from '../../scripts/measure-tracker.mjs';

describe('pendingWork', () => {
  it('lists every arm and run when nothing has been done', () => {
    expect(pendingWork([], { arms: ['none', 'ptasks'], runs: 2 }))
      .toEqual([
        { arm: 'none', run: 1 }, { arm: 'none', run: 2 },
        { arm: 'ptasks', run: 1 }, { arm: 'ptasks', run: 2 },
      ]);
  });

  it('skips a run that already has rows', () => {
    const rows = [{ arm: 'none', run: 1, session: 1 }];
    expect(pendingWork(rows, { arms: ['none'], runs: 2 })).toEqual([{ arm: 'none', run: 2 }]);
  });

  it('treats a run as done even if it stopped early, so restarts never redo work', () => {
    const rows = [{ arm: 'none', run: 1, session: 4 }];
    expect(pendingWork(rows, { arms: ['none'], runs: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `measure-tracker.mjs`**

```js
#!/usr/bin/env node
// Does an agent finish a long job better WITH a task tracker than without, and
// does it matter which tracker?
//
//   node plugins/p-tasks/scripts/measure-tracker.mjs --smoke
//   node plugins/p-tasks/scripts/measure-tracker.mjs --pilot
//   node plugins/p-tasks/scripts/measure-tracker.mjs --arm ptasks
//   node plugins/p-tasks/scripts/measure-tracker.mjs --score
//
// Three arms over the same polygon: `none` has no tracker at all, `ptasks` and
// `beads` each have one. Ten fresh sessions a run, five runs an arm. Nothing is
// judged by a model: after every session the tree is copied and scored against
// a hidden node:test suite the agent never sees.
//
// Rows are appended to runs.jsonl and a finished run is never repeated, so this
// can be stopped and restarted.
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OFF_SETTINGS, prepArm, preflight } from './measure-tracker/arms.mjs';
import { runSession } from './measure-tracker/session.mjs';
import { snapshot, changedLines } from './measure-tracker/snapshot.mjs';
import { scoreSnapshot, expectedTests } from './measure-tracker/score.mjs';
import { report } from './measure-tracker/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const POLYGON = join(HERE, 'polygon');
const REFERENCE = join(HERE, 'polygon-reference');
const ACCEPTANCE = join(HERE, 'polygon-acceptance', 'acceptance.test.js');

const ARMS = ['none', 'ptasks', 'beads'];
const RUNS = 5;
const SESSIONS = 10;
const CAP_USD = 5;
const MODEL = 'sonnet';

const args = process.argv.slice(2);
const flag = (n, f = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return f;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

// Its own work directory and its own settings file. A p-graph measurement may
// be running at the same time and must not be disturbed.
const work = String(flag('work', join(tmpdir(), 'ptasks-measure')));
const runsFile = join(work, 'runs.jsonl');
const settingsFile = join(work, 'ptasks-arm-settings.json');
const maxTotalUsd = Number(flag('max-total-usd', 150));

/** Which (arm, run) pairs still need doing. A run with any row is finished. */
export function pendingWork(rows, { arms, runs }) {
  const seen = new Set(rows.map((r) => `${r.arm} ${r.run}`));
  const out = [];
  for (const arm of arms) {
    for (let run = 1; run <= runs; run++) {
      if (!seen.has(`${arm} ${run}`)) out.push({ arm, run });
    }
  }
  return out;
}

const readRows = () => (existsSync(runsFile)
  ? readFileSync(runsFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

// Looked up when a session is about to run, never at import time: this module
// is imported by a unit test, and a machine without the CLI installed must not
// fail to import it.
function findClaude() {
  if (process.platform !== 'win32') return 'claude';
  const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai',
    'claude-code', 'bin', 'claude.exe');
  if (existsSync(exe)) return exe;
  throw new Error(`claude.exe not found at ${exe}`);
}

// The polygon is a directory inside this repository, not a repository of its
// own, so there is nothing to clone: copy it and give the copy one seed commit.
// The commit happens before the arm is installed, so no arm's own files are in
// the history that every arm starts from.
function freshCopy(arm, run) {
  const dir = join(work, `${arm}-${run}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(POLYGON, dir, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=harness@local', '-c', 'user.name=harness',
    'commit', '--quiet', '-m', 'seed'], { cwd: dir });
  return prepArm({ arm, dir, pluginDir: PLUGIN });
}

async function runOne(arm, run, sessions, expected) {
  const claudeBin = findClaude();
  const dir = freshCopy(arm, run);
  const seedSnap = snapshot(dir, join(work, 'snapshots', `${arm}-${run}`, 's00'));
  let prev = seedSnap;
  let consecutiveErrors = 0;

  for (let session = 1; session <= sessions; session++) {
    process.stderr.write(`  ${arm} #${run} session ${session} … `);
    const res = runSession({
      dir, arm, pluginDir: PLUGIN, settingsFile, capUsd: CAP_USD, model: MODEL, claudeBin,
    });
    const snap = snapshot(dir, join(work, 'snapshots', `${arm}-${run}`, `s${String(session).padStart(2, '0')}`));
    const row = {
      arm, run, session,
      ...res,
      tests: scoreSnapshot({ snapshotDir: snap, acceptanceFile: ACCEPTANCE, expected }),
      changed_lines_from_prev: changedLines(prev, snap),
      changed_lines_from_seed: changedLines(seedSnap, snap),
    };
    appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
    prev = snap;

    const green = row.tests ? Object.values(row.tests) : [];
    const doneNow = green.length > 0 && green.every(Boolean);
    process.stderr.write(res.error
      ? `ERROR ${res.error}\n`
      : `$${(res.cost_usd ?? 0).toFixed(3)} ${green.filter(Boolean).length}/${green.length}\n`);

    consecutiveErrors = res.error ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) {
      process.stderr.write(`  ${arm} #${run} aborted after three failed sessions\n`);
      return;
    }
    if (doneNow) {
      process.stderr.write(`  ${arm} #${run} finished at session ${session}\n`);
      return;
    }
    const spent = readRows().reduce((n, r) => n + (r.cost_usd ?? 0), 0);
    if (spent > maxTotalUsd) throw new Error(`stopping: spent $${spent.toFixed(2)}, over --max-total-usd ${maxTotalUsd}`);
  }
}

async function main() {
  mkdirSync(work, { recursive: true });
  writeFileSync(settingsFile, OFF_SETTINGS);

  if (flag('score')) { process.stdout.write(report(readRows())); return; }

  const smoke = Boolean(flag('smoke'));
  const pilot = Boolean(flag('pilot'));
  const arms = flag('arm') ? [String(flag('arm'))] : (pilot ? ['none', 'ptasks'] : ARMS);
  const runs = smoke || pilot ? 1 : RUNS;
  const sessions = smoke ? 1 : SESSIONS;

  for (const arm of arms) preflight(arm);

  // Read the suite's test list once, from the reference, before any session
  // runs. If this comes back short, the hidden suite is broken and every
  // score afterwards would be wrong in the same direction.
  const expected = expectedTests({ referenceDir: REFERENCE, acceptanceFile: ACCEPTANCE });
  if (expected.length < 30) throw new Error(`the hidden suite reported only ${expected.length} tests against the reference`);

  for (const { arm, run } of pendingWork(readRows(), { arms, runs })) {
    await runOne(arm, run, sessions, expected);
  }
  process.stdout.write(report(readRows()));
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
```

- [ ] **Step 4: Run the queue test to see it pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-queue.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker.mjs plugins/p-tasks/tools/__tests__/measure-queue.test.ts
git commit -m "feat(p-tasks): add the CLI that runs the tracker A/B study"
```

---

### Task 9: `report.mjs` — the tables

**Files:**
- Create: `plugins/p-tasks/scripts/measure-tracker/report.mjs`
- Create: `plugins/p-tasks/tools/__tests__/measure-report.test.ts`

**Interfaces:**
- Consumes: `done`, `sessionsToDone`, `regressionRate`, `churn`, `capShare` from Task 3.
- Produces: `report(rows)` returning a markdown string. Task 8 prints it.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-tasks/tools/__tests__/measure-report.test.ts
import { describe, expect, it } from 'vitest';
import { report } from '../../scripts/measure-tracker/report.mjs';

const row = (arm: string, run: number, session: number, tests: Record<string, boolean>) =>
  ({ arm, run, session, tests, cost_usd: 1, hit_cap: false, error: null,
     changed_lines_from_prev: 10, changed_lines_from_seed: 10 * session });

describe('report', () => {
  it('gives one row per arm with the spread, not only the mean', () => {
    const rows = [
      row('none', 1, 1, { R1: true, R2: false }),
      row('ptasks', 1, 1, { R1: true, R2: true }),
    ];
    const out = report(rows);
    expect(out).toContain('| none |');
    expect(out).toContain('| ptasks |');
    expect(out).toContain('spread');
  });

  it('says plainly when the dollar cap bound too often to trust the numbers', () => {
    const rows = [{ ...row('none', 1, 1, { R1: true }), hit_cap: true }];
    expect(report(rows)).toContain('the cap bound');
  });

  it('does not crash on an empty study', () => {
    expect(report([])).toContain('no runs');
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `report.mjs`**

```js
import { done, sessionsToDone, regressionRate, churn, capShare } from './metrics.mjs';

const byRun = (rows) => {
  const runs = new Map();
  for (const r of rows) {
    const key = `${r.arm} ${r.run}`;
    if (!runs.has(key)) runs.set(key, { arm: r.arm, run: r.run, sessions: [] });
    runs.get(key).sessions.push(r);
  }
  for (const v of runs.values()) v.sessions.sort((a, b) => a.session - b.session);
  return [...runs.values()];
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x, digits = 2) => (x === null || x === undefined ? '—' : x.toFixed(digits));
const spread = (xs) => (xs.length < 2 ? '—' : `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`);

// A single number hides everything that matters about feature work: five runs
// with the same mean can be five identical runs or two disasters and three wins.
//
// `done` is the share of hidden TESTS green, not of requirements. Every test
// name starts with its requirement id, so the write-up can group by the `R\d+`
// prefix wherever "R7 was the last to go green" reads better than a percentage.
export function report(rows) {
  if (!rows.length) return '\nno runs yet\n';
  const runs = byRun(rows);
  const arms = [...new Set(runs.map((r) => r.arm))];

  const lines = ['', '| arm | runs | done | spread | sessions to done | regressions / hand-over | churn | $ per run |',
    '|---|---|---|---|---|---|---|---|'];
  for (const arm of arms) {
    const mine = runs.filter((r) => r.arm === arm);
    const dones = mine.map((r) => done(r.sessions)).filter((x) => x !== null);
    const finished = mine.map((r) => sessionsToDone(r.sessions)).filter((x) => x !== null);
    const regs = mine.map((r) => regressionRate(r.sessions)).filter((x) => x !== null);
    const churns = mine.map((r) => churn(r.sessions)).filter((x) => x !== null);
    const costs = mine.map((r) => r.sessions.reduce((n, s) => n + (s.cost_usd ?? 0), 0));
    lines.push(`| ${arm} | ${mine.length} | ${fmt(mean(dones))} | ${spread(dones)} `
      + `| ${finished.length ? fmt(mean(finished), 1) : 'never'} | ${fmt(mean(regs))} `
      + `| ${fmt(mean(churns))} | ${fmt(mean(costs))} |`);
  }

  const capped = capShare(rows);
  if (capped !== null && capped > 0.05) {
    lines.push('', `**the cap bound in ${(capped * 100).toFixed(0)}% of sessions — `
      + 'the regression numbers above are void until the per-session cap goes up**');
  }
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/measure-report.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole suite on Windows**

Run: `npx vitest run`
Expected: PASS, with the new `measure-*` files included and no pre-existing test broken.

- [ ] **Step 6: Run the whole suite under WSL**

`.claude/CLAUDE.md` requires this — a Windows-only run verifies nothing here.

```bash
wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npx vitest run'
```

Copy the worktree in first if `~/pshed` does not already hold it, following the
setup notes in `.claude/CLAUDE.md`. Report both platforms' numbers and say which
one is the WSL run.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-tasks/scripts/measure-tracker/report.mjs plugins/p-tasks/tools/__tests__/measure-report.test.ts
git commit -m "feat(p-tasks): report the tracker A/B tables with the spread, not only the mean"
```

---

### Task 10: Smoke — one real session per arm (~$1.50)

**Files:** none created. This task spends money.

- [ ] **Step 1: Ask before spending**

Tell the user: three real sessions, about $1.50, to prove each arm is wired up
before the pilot. Wait for a yes.

- [ ] **Step 2: Install `bd` if it is missing**

Run: `bd version`
If it is not on PATH, install beads and try again. `preflight` will refuse to
start the arm otherwise, which is the point.

- [ ] **Step 3: Run the smoke**

```bash
node plugins/p-tasks/scripts/measure-tracker.mjs --smoke
```

- [ ] **Step 4: Check three things by hand**

1. Every arm exited without an error row.
2. In the `ptasks` and `beads` arms, the tracker has items in it — read
   `docs/tasks/tasks.yml` and run `bd list` in the run directories under
   `%TEMP%\ptasks-measure`. **An empty tracker means the rule was never seen**,
   and the arm would lose for a setup reason. Fix the rule placement and re-run
   before going further.
3. The hidden suite scored something — `tests` is not `null` in any row.

- [ ] **Step 5: Record what was found**

Append a short "smoke" section to the spec with what each arm did, and commit.

---

### Task 11: Pilot — calibrate the polygon (~$10)

**Files:** none created. This task spends money.

- [ ] **Step 1: Ask before spending**

About $10: two arms, one run each, ten sessions each.

- [ ] **Step 2: Run the pilot**

```bash
node plugins/p-tasks/scripts/measure-tracker.mjs --pilot
node plugins/p-tasks/scripts/measure-tracker.mjs --score
```

- [ ] **Step 3: Apply the two gates from the spec**

| Check | Pass | If it fails |
|---|---|---|
| `ptasks` done is between 0.40 and 0.90 | the feature is the right size | below, cut requirements from `SPEC.md`; above, add some |
| `ptasks` and `none` differ by at least 0.15 | there is something to measure | rewrite the feature so later requirements truly need the earlier ones |

- [ ] **Step 4: If a gate failed, change the polygon and start over**

Delete the pilot rows from `runs.jsonl`, change `SPEC.md`, the reference and the
hidden suite together, re-run the Task 2 gate, and pilot again. Cheap now,
expensive after the full study.

- [ ] **Step 5: Commit the calibrated polygon**

```bash
git add plugins/p-tasks/scripts/polygon plugins/p-tasks/scripts/polygon-reference plugins/p-tasks/scripts/polygon-acceptance
git commit -m "test(p-tasks): calibrate the polygon against the pilot"
```

---

### Task 12: The full study (~$60–100)

**Files:**
- Create: `plugins/p-tasks/docs/measured-tracker-ab.md`

- [ ] **Step 1: Ask before spending**

State the cost and the wall-clock time. Wait for a yes.

- [ ] **Step 2: Run every arm**

```bash
node plugins/p-tasks/scripts/measure-tracker.mjs --arm none
node plugins/p-tasks/scripts/measure-tracker.mjs --arm ptasks
node plugins/p-tasks/scripts/measure-tracker.mjs --arm beads
node plugins/p-tasks/scripts/measure-tracker.mjs --score
```

Run them one at a time. A p-graph measurement may be running in the main
checkout, and two studies fighting for the same rate limit make both slower and
neither more correct.

- [ ] **Step 3: Check the cap did not bind**

If the report prints the "the cap bound" warning, raise `CAP_USD`, delete the
affected rows, and re-run those runs. The regression numbers are not publishable
until it is quiet.

- [ ] **Step 4: Write the study up**

`plugins/p-tasks/docs/measured-tracker-ab.md`: the tables from `--score`, the
answer to the one question (keep p-tasks or move), and — copied from the spec's
section 14 — what these numbers may not claim. State plainly that `p-tasks`
against `beads` is clean and `tracker` against `none` is coarse.

- [ ] **Step 5: Commit and hand back**

```bash
git add plugins/p-tasks/docs/measured-tracker-ab.md
git commit -m "docs(p-tasks): the measured answer on keeping p-tasks or moving to beads"
```

Then ask the user whether to merge the `tracker-ab` worktree branch, and whether
the result changes anything in p-tasks itself.
