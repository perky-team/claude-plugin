# Read-only External Sources for p-wiki — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a p-wiki point at one or more read-only sources (a foreign p-wiki Confluence space, or another on-disk wiki) so `search`/`query`/`get` read from them alongside the primary destination, never writing.

**Architecture:** A new optional `sources` array in `.pwiki.json` references entries in `destinations` (same blocks as `mirrors`, but read-only). `resolveDestination` exposes them lazily. The `search` command unions primary + each source (tagging every result with its `source`, capturing per-source failures in a `warnings` array). The `get` command gains a `--source=<name>` flag that routes the read. Both reuse the existing per-backend `search`/`readPage` unchanged.

**Tech Stack:** Node.js ESM (`.mjs`), Vitest, no new dependencies. Tests live in `plugins/p-wiki/tools/__tests__/`.

## Global Constraints

- All work is under `plugins/p-wiki/`. Run tests from that directory: `npm test` (or `npx vitest run <file>`).
- Source files are ESM `.mjs`; tests are `.test.ts` using Vitest (`import { describe, expect, it } from 'vitest'`).
- No new runtime dependencies.
- The CLI prints machine output via `emitJson(obj, code)` and dies via `die(msg, code)`; exit codes: 0 success, 1 user/env error, 2 schema/conflict, 3 internal.
- Spec being implemented: `plugins/p-wiki/docs/superpowers/specs/2026-06-17-pwiki-external-readonly-source-design.md`. All section (§) references below point there.
- Plugin version bump (`4.10.0 → 4.11.0`) and the monorepo tag are handled by the repo's release procedure at push time — **not** in this plan. Do not edit `plugin.json` here.
- All artifact text (code comments, docs) in English.
- Commit after each task. No Claude attribution in commit messages.

---

## File Structure

- `tools/lib/config.mjs` — `validateConfig` gains `sources` + `fs.path` validation. (Modify.)
- `tools/lib/destination.mjs` — `resolveDestination` returns `sources`/`sourceNames`; `makeDestination` honors `fs.path`. (Modify.)
- `tools/pwiki.mjs` — extract `searchCommand`, add union + `warnings`; `getPage` gains `--source` routing. (Modify.)
- `tools/__tests__/config.test.ts` — validation tests. (Modify.)
- `tools/__tests__/destination-resolve.test.ts` — resolution tests. (Modify.)
- `tools/__tests__/cli-search-sources.test.ts` — search union + warnings. (Create.)
- `tools/__tests__/cli-get-sources.test.ts` — `get --source` routing (FS + Confluence). (Create.)
- `skills/query/SKILL.md` — pass `--source`, mention warnings. (Modify.)
- `README.md`, `skills/_shared/templates/wiki-claude-md.template.md` — docs. (Modify.)

---

## Task 1: Config validation for `sources` and `fs.path`

**Files:**
- Modify: `plugins/p-wiki/tools/lib/config.mjs` (function `validateConfig`, currently ends at line 58)
- Test: `plugins/p-wiki/tools/__tests__/config.test.ts`

**Interfaces:**
- Consumes: existing `validateConfig(cfg) → { ok: boolean, error?: string }`.
- Produces: `validateConfig` additionally rejects: a non-array `sources`; a source name absent from `destinations`; a source name that is also `primary` or a mirror; an `fs` block whose `path` is present but not a non-empty string. Error strings match `/source/` or `/path/` accordingly.

- [ ] **Step 1: Write the failing tests**

Add to `config.test.ts`, inside the `describe('config v3', ...)` block (after the existing `validateConfig` tests, before the `readConfig throws` test):

```ts
  it('validateConfig accepts a valid sources array', () => {
    const cfg = {
      primary: 'fs',
      mirrors: [],
      sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: '/some/abs/path' } },
    };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('validateConfig rejects a source not present in destinations', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: ['ghost'],
      destinations: { fs: { kind: 'fs' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source.*ghost/);
  });

  it('validateConfig rejects a source that is also the primary', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: ['fs'],
      destinations: { fs: { kind: 'fs' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source.*fs/);
  });

  it('validateConfig rejects a source that is also a mirror', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: ['other'], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: '/p' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source.*other/);
  });

  it('validateConfig rejects a non-array sources', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: 'other',
      destinations: { fs: { kind: 'fs' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sources/);
  });

  it('validateConfig rejects an fs block with an empty path', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: '' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/path/);
  });

  it('validateConfig still accepts a config with no sources field', () => {
    const cfg = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
    expect(validateConfig(cfg).ok).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/config.test.ts`
Expected: the new `sources` / `path` tests FAIL (validation not yet implemented — e.g. "rejects a source not present" gets `ok: true`).

- [ ] **Step 3: Implement the validation**

In `config.mjs`, inside `validateConfig`, after the existing mirrors loop (the block ending `}` at line 42, right before `for (const [name, block] of Object.entries(cfg.destinations))`), insert:

```js
  if (cfg.sources !== undefined && !Array.isArray(cfg.sources)) return { ok: false, error: 'sources must be an array of strings' };
  const writeRoles = new Set([cfg.primary, ...(cfg.mirrors ?? [])]);
  for (const s of cfg.sources ?? []) {
    if (typeof s !== 'string' || !s) return { ok: false, error: 'source name must be a non-empty string' };
    if (!(s in cfg.destinations)) return { ok: false, error: `source "${s}" not defined in destinations` };
    if (writeRoles.has(s)) return { ok: false, error: `source "${s}" is also used as primary or a mirror (roles are mutually exclusive)` };
  }
```

Then, inside the existing `for (const [name, block] of Object.entries(cfg.destinations))` loop, after the `if (block.kind === 'confluence') { ... }` branch (after line 55, before the loop's closing `}`), add the fs path check:

```js
    if (block.kind === 'fs' && block.path !== undefined && (typeof block.path !== 'string' || !block.path)) {
      return { ok: false, error: `destinations.${name}.path must be a non-empty string` };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/config.test.ts`
Expected: PASS (all, including the pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/config.mjs plugins/p-wiki/tools/__tests__/config.test.ts
git commit -m "feat(p-wiki): validate read-only sources and fs path in config"
```

---

## Task 2: Resolve `sources` lazily and honor `fs.path`

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destination.mjs` (lines 36-63, `resolveDestination`; line 23-30, `makeDestination`)
- Test: `plugins/p-wiki/tools/__tests__/destination-resolve.test.ts`

**Interfaces:**
- Consumes: `validateConfig` (Task 1); `createFsDestination({ root, destinationConfig })`; `createConfluenceDestination({ root, destinationConfig, transport })`.
- Produces: `resolveDestination(env)` return shape gains `sources` (lazy Proxy array of `Destination`) and `sourceNames` (`string[]`), in addition to the existing `primary`, `primaryName`, `mirrors`, `mirrorNames`. An `fs` destination block with a `path` is rooted at `resolve(repoRoot, block.path)`.

- [ ] **Step 1: Write the failing tests**

Add to `destination-resolve.test.ts`, inside the `describe('destination.resolveDestination', ...)` block. (The file already imports `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync`, `tmpdir`, `join`, `resolveDestination`, `writeConfig`.)

```ts
  it('resolves sources lazily (confluence source)', () => {
    writeConfig(dir, {
      primary: 'fs',
      mirrors: [],
      sources: ['conf'],
      destinations: {
        fs: { kind: 'fs' },
        conf: {
          kind: 'confluence',
          siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
          rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
        },
      },
    });
    let calls = 0;
    const transport = async () => ({ status: 200, headers: {}, body: {} });
    const r = resolveDestination({ cwd: dir, transport, _spyConfluenceFactory: () => calls++ });
    expect(r!.sourceNames).toEqual(['conf']);
    expect(calls).toBe(0);               // lazy
    expect(r!.sources[0].kind).toBe('confluence');
    expect(calls).toBe(1);               // built on first access
    void r!.sources[0];
    expect(calls).toBe(1);               // cached
  });

  it('roots an fs source at its configured path', () => {
    // A second wiki on disk, outside the primary repo.
    const other = mkdtempSync(join(tmpdir(), 'pwiki-other-'));
    mkdirSync(join(other, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(
      join(other, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'),
      '---\nid: kafka\ntype: concept\ntitle: Kafka\n---\n\n# Kafka\n\nbody\n',
      'utf-8',
    );
    try {
      writeConfig(dir, {
        primary: 'fs',
        mirrors: [],
        sources: ['other'],
        destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: other } },
      });
      const r = resolveDestination({ cwd: dir });
      const page = r!.sources[0].readPage('docs/wiki/pages/concept/kafka.md');
      expect(page.frontmatter.id).toBe('kafka');
      expect(page.body).toContain('# Kafka');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/destination-resolve.test.ts`
Expected: FAIL — `r.sourceNames` is `undefined` / `r.sources` is `undefined`.

- [ ] **Step 3: Implement source resolution and fs path rooting**

In `destination.mjs`:

(a) Add a `resolve` import at the top, joining the existing imports:

```js
import { resolve } from 'node:path';
```

(b) Change `makeDestination` (lines 23-30) so an fs block honors `path`. Replace:

```js
function makeDestination(name, block, root, env) {
  if (block.kind === 'fs') return createFsDestination({ root, destinationConfig: block });
  if (block.kind === 'confluence') {
```

with:

```js
function makeDestination(name, block, root, env) {
  if (block.kind === 'fs') {
    const fsRoot = block.path ? resolve(root, block.path) : root;
    return createFsDestination({ root: fsRoot, destinationConfig: block });
  }
  if (block.kind === 'confluence') {
```

(c) Extract the lazy-Proxy construction into a helper so mirrors and sources share it. Replace the mirrors block (lines 46-60) and the `return` (line 62) with:

```js
  function lazyList(names) {
    const cache = new Array(names.length);
    return new Proxy(cache, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const i = Number(prop);
          if (target[i] === undefined && i < names.length) {
            const name = names[i];
            target[i] = makeDestination(name, cfg.destinations[name], root, env);
          }
          return target[i];
        }
        return Reflect.get(target, prop);
      },
    });
  }

  const mirrorNames = [...(cfg.mirrors ?? [])];
  const mirrors = lazyList(mirrorNames);
  const sourceNames = [...(cfg.sources ?? [])];
  const sources = lazyList(sourceNames);

  return { primary, primaryName, mirrors, mirrorNames, sources, sourceNames };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/destination-resolve.test.ts`
Expected: PASS (including the pre-existing mirror-lazy test, which now goes through `lazyList`).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destination.mjs plugins/p-wiki/tools/__tests__/destination-resolve.test.ts
git commit -m "feat(p-wiki): resolve read-only sources lazily and root fs sources by path"
```

---

## Task 3: `search` unions primary + sources with a `warnings` array

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (the `if (command === 'search') { ... }` block, lines 413-430)
- Test: `plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts` (create)

**Interfaces:**
- Consumes: `resolveDestination` (Task 2) returning `primary`, `primaryName`, `sources`, `sourceNames`; existing `mapErrorToCode`, `emitJson`, `die`, `makeRealTransport`.
- Produces: exported `async function searchCommand(args, _opts = {})`. Emits JSON `{ query, total, results, warnings }` where each result carries a `source: <name>` field, `total` is the sum across primary + reachable sources, and `warnings` is an array of `{ source, code, message }` for sources that threw (empty array when none). The `if (command === 'search')` dispatcher calls `await searchCommand(args)`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { searchCommand } from '../pwiki.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

const PAGE = (id: string, title: string, extra = '') =>
  `---\nid: ${id}\ntype: concept\ntitle: ${title}\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources: []\n---\n\n# ${title}\n\nKafka content. ${extra}\n`;

describe('pwiki search — union over sources (FS primary + FS source)', () => {
  let primaryDir: string;
  let sourceDir: string;
  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'pwiki-search-primary-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'pwiki-search-source-'));
    mkdirSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    mkdirSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'), PAGE('kafka', 'Kafka'));
    writeFileSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept', 'kafka-ext.md'), PAGE('kafka-ext', 'Kafka External'));
    writeFileSync(join(primaryDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: sourceDir } },
    }), 'utf-8');
  });
  afterEach(() => {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('returns results from primary and source, each tagged with its source', () => {
    const r = spawnSync('node', [cli, 'search', 'kafka', '--format=json'], { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    const bySource = new Map(json.results.map((x: any) => [x.source, x]));
    expect(bySource.has('fs')).toBe(true);
    expect(bySource.has('other')).toBe(true);
    expect(json.total).toBe(2);
    expect(json.warnings).toEqual([]);
  });
});

describe('pwiki search — a failing source becomes a warning (in-process)', () => {
  let dir: string;
  let cwd: string;
  let exitSpy: any;
  let stdoutSpy: any;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pwiki-search-warn-'));
    mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'), PAGE('kafka', 'Kafka'));
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['conf'],
      destinations: {
        fs: { kind: 'fs' },
        conf: {
          kind: 'confluence', siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1',
          rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' },
        },
      },
    }), 'utf-8');
    cwd = process.cwd();
    process.chdir(dir);
    out = '';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('keeps primary results and records the source error', async () => {
    // Transport that fails every request → confluence source.search throws.
    const failing = async () => ({ status: 500, headers: {}, body: { message: 'boom' } });
    try {
      await searchCommand({ _: ['kafka'], format: 'json' }, { transport: failing });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const json = JSON.parse(out);
    expect(json.results.some((x: any) => x.source === 'fs')).toBe(true);
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0].source).toBe('conf');
    expect(json.warnings[0].code).toBe('network-error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-search-sources.test.ts`
Expected: FAIL — `searchCommand` is not exported; the union/warnings behavior does not exist.

- [ ] **Step 3: Extract `searchCommand` and implement the union**

In `pwiki.mjs`, replace the entire `if (command === 'search') { ... }` block (lines 413-430) with a call to a new exported function:

```js
  if (command === 'search') {
    await searchCommand(args);
  }
```

Then add the exported function near `getPage` (e.g. right after `getPage`'s closing brace at line 236):

```js
export async function searchCommand(args, _opts = {}) {
  const query = args._[0];
  if (!query) die(`search: <query> required`, 1);
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts.transport ?? makeRealTransport() });
  if (!res) die(`not inside a p-wiki repo`, 1);

  const opts = {
    type: typeof args.type === 'string' ? args.type.split(',').map(s => s.trim()).filter(Boolean) : [],
    tags: typeof args.tags === 'string' ? args.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
    in: args.in ?? 'pages',
    limit: args.limit ? Number(args.limit) : 10,
    snippet: args.snippet === 'false' ? false : true,
  };

  const warnings = [];
  const primary = await res.primary.search(query, opts);
  let results = primary.results.map(r => ({ ...r, source: res.primaryName }));
  let total = primary.total;

  for (let i = 0; i < res.sourceNames.length; i++) {
    const name = res.sourceNames[i];
    try {
      const dest = res.sources[i];                       // construction may throw → caught below
      const sr = await dest.search(query, opts);
      results = results.concat(sr.results.map(r => ({ ...r, source: name })));
      total += sr.total;
    } catch (e) {
      warnings.push({ source: name, code: mapErrorToCode(e), message: e?.message ?? String(e) });
    }
  }

  emitJson({ query, total, results, warnings }, 0);
}
```

(`mapErrorToCode`, `emitJson`, `die`, `resolveDestination`, `makeRealTransport` are all already defined/imported in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-search-sources.test.ts tools/__tests__/cli-search.test.ts`
Expected: PASS for both the new union tests and the pre-existing `cli-search.test.ts` (now-emitted `warnings: []` and per-result `source` are additive; existing assertions still hold).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts
git commit -m "feat(p-wiki): union search across read-only sources with warnings"
```

---

## Task 4: `get --source=<name>` routing

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (`getPage`, lines 209-236)
- Test: `plugins/p-wiki/tools/__tests__/cli-get-sources.test.ts` (create)

**Interfaces:**
- Consumes: `resolveDestination` (Task 2) returning `primary`, `primaryName`, `sources`, `sourceNames`; existing `getPage` body (readPage + error handling + output).
- Produces: `getPage` honors `args.source`: absent or equal to `primaryName` → primary; a name in `sourceNames` → that source; any other value → `{ error: { code: 'unknown-source', message } }`, exit 1.

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-wiki/tools/__tests__/cli-get-sources.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { getPage } from '../pwiki.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

describe('pwiki get --source (FS primary + FS source)', () => {
  let primaryDir: string;
  let sourceDir: string;
  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'pwiki-get-primary-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'pwiki-get-source-'));
    mkdirSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    mkdirSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept', 'home.md'),
      '---\nid: home\ntype: concept\ntitle: Home\n---\n\n# Home\n\nprimary body\n');
    writeFileSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept', 'ext.md'),
      '---\nid: ext\ntype: concept\ntitle: Ext\n---\n\n# Ext\n\nsource body\n');
    writeFileSync(join(primaryDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: sourceDir } },
    }), 'utf-8');
  });
  afterEach(() => {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('reads a page from the named source', () => {
    const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/ext.md', '--source=other', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).body).toContain('source body');
  });

  it('reads from primary when --source is omitted', () => {
    const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/home.md', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).body).toContain('primary body');
  });

  it('unknown --source → exit 1 with error.code unknown-source', () => {
    const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/ext.md', '--source=nope', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('unknown-source');
  });
});

describe('pwiki get --source (Confluence source, fake transport)', () => {
  let dir: string;
  let cwd: string;
  let exitSpy: any;
  let stdoutSpy: any;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pwiki-get-confsrc-'));
    mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder');
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['conf'],
      destinations: {
        fs: { kind: 'fs' },
        conf: {
          kind: 'confluence', siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1',
          rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' },
        },
      },
    }), 'utf-8');
    cwd = process.cwd();
    process.chdir(dir);
    process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
    process.env.PWIKI_CONFLUENCE_TOKEN = 't';
    out = '';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('rebuilds identity via the subParents children scan and reads the source page', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }] };
    const fake = createFakeConfluence({
      spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
      initialPages: [
        { id: '200', title: 'Foo', parentId: '101', body: adf, properties: [
          { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
          { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-tags', value: '["streaming"]' },
        ] },
      ],
    });
    try {
      await getPage({ _: ['confluence://concept/foo'], source: 'conf', format: 'json' }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const json = JSON.parse(out);
    expect(json.frontmatter.title).toBe('Foo');
    expect(json.body).toBe('# Foo');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-get-sources.test.ts`
Expected: FAIL — `getPage` ignores `--source`, so the source reads hit primary (page-not-found) and `unknown-source` is never emitted.

- [ ] **Step 3: Implement `--source` routing in `getPage`**

In `pwiki.mjs`, in `getPage` (lines 209-236), replace:

```js
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts.transport ?? makeRealTransport() });
  if (!res) die('not inside a p-wiki repo', 1);
  const dest = res.primary;
```

with:

```js
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts.transport ?? makeRealTransport() });
  if (!res) die('not inside a p-wiki repo', 1);

  const srcName = typeof args.source === 'string' ? args.source : undefined;
  let dest;
  if (!srcName || srcName === res.primaryName) {
    dest = res.primary;
  } else {
    const idx = res.sourceNames.indexOf(srcName);
    if (idx === -1) emitJson({ error: { code: 'unknown-source', message: `unknown source: ${srcName}` } }, 1);
    dest = res.sources[idx];
  }
```

The rest of `getPage` (the `readPage` call on `dest`, error matching, and output) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-get-sources.test.ts tools/__tests__/cli-get.test.ts tools/__tests__/cli-get-confluence.test.ts`
Expected: PASS for the new routing tests and the pre-existing get tests (no-flag path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-get-sources.test.ts
git commit -m "feat(p-wiki): route pwiki get to a read-only source via --source"
```

---

## Task 5: Update the `query` skill and documentation

**Files:**
- Modify: `plugins/p-wiki/skills/query/SKILL.md` (Step 2 lines 20-28; Step 3 lines 30-38; error table)
- Modify: `plugins/p-wiki/README.md` (Multi-destination section)
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md` (CLI section)

**Interfaces:**
- Consumes: the CLI behavior from Tasks 3-4 (`search` emits `source` + `warnings`; `get` accepts `--source`).
- Produces: no code; documentation only. Verified by inspection / grep.

- [ ] **Step 1: Update `query/SKILL.md` Step 3 to pass `--source`**

Replace the Step 3 code block (lines 33-36) and its following note so the read routes to the result's source. Change:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" get "<path>"
```

to:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" get "<path>" --source="<source>"
```

and add a sentence after the existing note: "Each search result carries a `source` field; pass it verbatim to `get --source` so a page from a read-only source is read from that source. Results from your own wiki carry the primary's name, which routes to the primary."

- [ ] **Step 2: Update `query/SKILL.md` Step 2 to surface warnings**

After the "Parse the JSON" paragraph (line 28), add:

> If the JSON `warnings` array is non-empty, prepend one short line to your reply naming the unavailable sources (e.g. "Note: source `team-confluence` was unreachable (network-error); answer is from the remaining wikis."), then continue with whatever results returned.

- [ ] **Step 3: Update the README Multi-destination section**

In `README.md`, in the "Multi-destination & `pwiki sync`" section, after the paragraph describing `mirrors`, add a paragraph:

```markdown
A wiki may also declare **read-only sources** — `"sources": ["other-wiki"]`, referencing `destinations` entries that p-wiki only *reads* (never writes). `search` and `query` union results from the primary plus every source (each result is tagged with its `source`; an unreachable source is reported in a `warnings` array rather than failing the search), and `pwiki get <path> --source=<name>` reads a page from a named source. Sources are p-wiki-formatted stores: a foreign Confluence space populated by another p-wiki (its block needs that space's `spaceId` / `rootPageId` / `subParents` — copy them from the source wiki's own `.pwiki.json`), or another on-disk wiki via an `fs` block with a `path`. All Confluence blocks share the same `PWIKI_CONFLUENCE_EMAIL` / `PWIKI_CONFLUENCE_TOKEN`, so a source on a different Atlassian account is not supported.
```

- [ ] **Step 4: Update the wiki CLAUDE.md template CLI section**

In `skills/_shared/templates/wiki-claude-md.template.md`, in the "CLI tool" list of operations, add:

```markdown
- `pwiki get <path> --source=<name>` — read a page from a configured read-only source (omit `--source` for the primary).
- `pwiki search <query>` unions the primary with every entry in the config's `sources` array; each result carries a `source` field and the JSON includes a `warnings` array for unreachable sources.
```

- [ ] **Step 5: Verify the doc edits landed**

Run: `cd plugins/p-wiki && npx vitest run` (full suite — confirms no skill/doc edit accidentally broke a snapshot or path-referencing test) and then:

Run (Grep, not bash): search for `--source` in `skills/query/SKILL.md`, `README.md`, and the template.
Expected: full test suite PASS; `--source` present in all three files.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-wiki/skills/query/SKILL.md plugins/p-wiki/README.md plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md
git commit -m "docs(p-wiki): document read-only sources in query skill, README, and template"
```

---

## Final verification

- [ ] Run the full p-wiki suite once more: `cd plugins/p-wiki && npm test`. Expected: all green.
- [ ] Confirm no `plugin.json` change was made (version/tag is the release step, performed separately at push time).

---

## Self-review notes (spec coverage)

- §2 config schema (`sources`, fs `path`) → Task 1 (validation) + Task 2 (resolution/rooting).
- §2.2 Confluence structural-ID requirement (cold-cache identity rebuild) → exercised by Task 4's Confluence-source test (subParents children scan via fake transport); documented in Task 5 README edit.
- §3 resolution → Task 2.
- §4 search union + `warnings` + per-source `--limit` (each backend's `search` already applies `opts.limit`, so passing the same `opts` to each gives per-source limiting) → Task 3.
- §5 `get --source` routing + `unknown-source` → Task 4.
- §6 query skill edits → Task 5.
- §7 error handling: `unknown-source` (Task 4), source-error-as-warning (Task 3), `config-invalid` (Task 1 via existing mapping).
- §8 testing → Tasks 1-4 tests.
- §9 docs → Task 5.
- §10 backwards compatibility → covered by re-running pre-existing suites in Tasks 3-5 (no-sources configs and existing search/get behavior unchanged).
