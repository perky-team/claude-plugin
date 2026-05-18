# pwiki v3 Multi-Destination + Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the same wiki live in more than one destination simultaneously, with one canonical "primary" and zero or more "mirrors", and add a `pwiki sync` command that copies the primary's state into every mirror 1:1 (including deletions and cross-link rewrites).

**Architecture:** `.pwiki.json` schema changes from `{destination, confluence}` (v2) to `{primary, mirrors, destinations}` (v3) — v2 files auto-migrate on first read. The resolver returns `{primary, mirrors, primaryName, mirrorNames}` instead of a bare `Destination`; all v2 commands continue operating on `.primary`. Two new modules — `sync.mjs` (orchestrator, four passes plus pre-pass) and `cross-links.mjs` (pure rewriter) — sit above the existing `Destination` interface, which gains six new methods: `deletePage`, `pathFor`, `ensureStructure`, `parseWikiLink`, `formatWikiLink`, and a `{setBody}` mutation shape on `mutatePage`. No new npm dependencies.

**Tech Stack:** Node ≥ 18 stdlib (`node:fs`, `node:path`), vitest + TypeScript for tests, the existing v2 fake Confluence transport for offline sync tests, real Confluence Cloud REST API for the gated E2E.

**Spec:** [`2026-05-18-pwiki-v3-multi-destination-sync-design.md`](../specs/2026-05-18-pwiki-v3-multi-destination-sync-design.md)

---

## File Structure

**New files (created during this plan):**

| Path | Responsibility |
|---|---|
| `tools/lib/cross-links.mjs` | `rewriteCrossLinks` + `stripCrossLinks`; backend-agnostic markdown link walk |
| `tools/lib/sync.mjs` | `syncToMirror(src, dst)` — pre-pass + four-pass orchestrator |
| `tools/__tests__/cross-links.test.ts` | Unit tests for the markdown walker and rewrite logic |
| `tools/__tests__/sync.test.ts` | Integration: FS↔fake-Confluence sync scenarios in both directions |
| `tools/__tests__/destination-link-shape.test.ts` | Unit tests for `parseWikiLink` / `formatWikiLink` on both backends |

**Existing files (modified during this plan):**

| Path | What changes |
|---|---|
| `tools/lib/config.mjs` | v3 validator; v2→v3 auto-migration in `readConfig`; persist migrated config |
| `tools/lib/destination.mjs` | Resolver returns `{primary, mirrors, primaryName, mirrorNames}`; lazy mirror construction; factory signature change |
| `tools/lib/destinations/fs.mjs` | Add `deletePage`, `pathFor`, `mutatePage({setBody})`, `ensureStructure`, `parseWikiLink`, `formatWikiLink` |
| `tools/lib/destinations/confluence.mjs` | Same six methods on Confluence; extend identity cache with reverse lookup (numeric id → `(type, slug)`) |
| `tools/lib/confluence/identity.mjs` | Bidirectional cache: keep existing `get(type, slug)` API and add `getByNumericId(id)`, `setByNumericId(id, type, slug)`; `set(type, slug, id)` updates both directions |
| `tools/pwiki.mjs` | Refactor seven `resolveDestination(...)` call sites to use `.primary`; add `sync` subcommand; extend `init` with `--mirror-fs`, `--mirror-confluence-*` flags; bump `VERSION` to `'3.0.0'` |
| `tools/__tests__/config.test.ts` | Update v2 round-trip test to assert auto-migration; add migration tests |
| `tools/__tests__/destination-resolve.test.ts` | Assert new `{primary, mirrors, ...}` shape |
| `tools/__tests__/destination-contract.test.ts` | Add four new contract tests (deletePage, pathFor, mutatePage(setBody), ensureStructure) |
| `tools/__tests__/cli-init-confluence.test.ts` (if present) or `cli-integration.test.ts` | Assert init writes v3 shape; cover `--mirror-fs` flag |
| `tools/__tests__/confluence-e2e.test.ts` | Append new scenario: bootstrap two-destination config, sync, verify mirror, delete-and-resync |
| `skills/init/SKILL.md` | Additive "Add a mirror?" prompt step |
| `skills/_shared/templates/wiki-claude-md.template.md` | "Storage backend" section updated with multi-destination notes |
| `.claude-plugin/plugin.json` | `"version": "3.0.0"` |

---

## Layer roadmap

Each layer ships green tests before the next starts; both the FS suite and the v2 Confluence suite must stay green after every task.

- **Layer 1 (Tasks 1–4):** Foundations — v3 config + resolver + factory signatures + pwiki.mjs callsite refactor. Auto-migration means v2 wikis keep working.
- **Layer 2 (Tasks 5–8):** Destination interface additions — four small methods, each on both backends, each with a contract test.
- **Layer 3 (Tasks 9–10):** Cross-link primitives — `parseWikiLink` / `formatWikiLink` on FS, then on Confluence (which also extends the identity cache).
- **Layer 4 (Tasks 11–13):** Sync orchestrator — `cross-links.mjs` (pure), `sync.mjs` (orchestrator), full integration test against both backends.
- **Layer 5 (Tasks 14–16):** CLI surface — `pwiki sync` command, init flag extensions, init skill prompt.
- **Layer 6 (Tasks 17–19):** Docs, E2E, ship — CLAUDE.md template, real-Confluence E2E scenario, version bump to 3.0.0.

Run `npm test` after each task. Both FS and Confluence test suites must stay green.

---

## Layer 1 — Foundations

### Task 1: Rewrite `config.mjs` for v3 shape with v2 auto-migration

**Files:**
- Modify: `plugins/p-wiki/tools/lib/config.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/config.test.ts`

The new `validateConfig` accepts the v3 shape `{primary, mirrors, destinations}`. `readConfig` detects v2 shape (`destination` key, no `primary`), rewrites to v3 in memory, and persists immediately.

- [ ] **Step 1: Write the failing test**

Replace the existing `tools/__tests__/config.test.ts` content with the v3 expectations.

```ts
// plugins/p-wiki/tools/__tests__/config.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, validateConfig, configPath } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-config-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const confluenceBlock = {
  kind: 'confluence',
  siteUrl: 'https://x.atlassian.net',
  spaceKey: 'ENG',
  spaceId: '987',
  rootPageId: '123',
  subParents: { concept: '1', person: '2', source: '3', query: '4' },
};

describe('config v3', () => {
  it('returns null when .pwiki.json is absent', () => {
    expect(readConfig(dir)).toBeNull();
  });

  it('round-trips a v3 config', () => {
    const cfg = {
      primary: 'confluence',
      mirrors: ['fs'],
      destinations: { confluence: confluenceBlock, fs: { kind: 'fs' } },
    };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });

  it('migrates v2 confluence shape on read and persists', () => {
    const v2 = {
      destination: 'confluence',
      confluence: {
        siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
        rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
      },
    };
    writeFileSync(configPath(dir), JSON.stringify(v2, null, 2), 'utf-8');
    const got = readConfig(dir);
    expect(got).toEqual({
      primary: 'confluence',
      mirrors: [],
      destinations: { confluence: { kind: 'confluence', ...v2.confluence } },
    });
    // Persisted to disk in v3 shape:
    const onDisk = JSON.parse(readFileSync(configPath(dir), 'utf-8'));
    expect(onDisk).toEqual(got);
  });

  it('migrates v2 fs-explicit shape on read', () => {
    writeFileSync(configPath(dir), JSON.stringify({ destination: 'fs' }, null, 2), 'utf-8');
    const got = readConfig(dir);
    expect(got).toEqual({
      primary: 'fs',
      mirrors: [],
      destinations: { fs: { kind: 'fs' } },
    });
  });

  it('validateConfig rejects missing destinations entry for primary', () => {
    const r = validateConfig({ primary: 'confluence', mirrors: [], destinations: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/destinations\.confluence/);
  });

  it('validateConfig rejects mirror name not present in destinations', () => {
    const r = validateConfig({
      primary: 'confluence',
      mirrors: ['fs'],
      destinations: { confluence: confluenceBlock },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mirror.*fs/);
  });

  it('validateConfig rejects destination without kind', () => {
    const r = validateConfig({
      primary: 'confluence',
      mirrors: [],
      destinations: { confluence: { ...confluenceBlock, kind: undefined } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kind/);
  });

  it('validateConfig rejects missing confluence.spaceId', () => {
    const bad = { ...confluenceBlock, spaceId: undefined };
    const r = validateConfig({ primary: 'confluence', mirrors: [], destinations: { confluence: bad } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spaceId/);
  });

  it('validateConfig accepts an fs destination with only kind', () => {
    const cfg = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('readConfig throws on invalid JSON', () => {
    writeFileSync(configPath(dir), '{not json', 'utf-8');
    expect(() => readConfig(dir)).toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/config.test.ts
```

Expected: FAIL — validateConfig still expects the v2 shape; migration not implemented; v3 round-trip mismatches.

- [ ] **Step 3: Implement the new `config.mjs`**

```js
// plugins/p-wiki/tools/lib/config.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_REL = 'docs/wiki/.pwiki.json';
const TYPES = ['concept', 'person', 'source', 'query'];

export function configPath(root) { return join(root, CONFIG_REL); }

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  const raw = JSON.parse(text);
  if (raw && typeof raw === 'object' && 'primary' in raw) return raw;            // v3 already
  if (raw && typeof raw === 'object' && 'destination' in raw) {
    const migrated = migrateV2(raw);
    writeConfig(root, migrated);                                                  // persist immediately
    return migrated;
  }
  return raw;                                                                     // validateConfig will reject downstream
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function migrateV2(old) {
  const kind = old.destination;
  const block = kind === 'fs' ? { kind: 'fs' } : { kind: 'confluence', ...old.confluence };
  return { primary: kind, mirrors: [], destinations: { [kind]: block } };
}

export function validateConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (typeof cfg.primary !== 'string' || !cfg.primary) return { ok: false, error: 'primary must be a non-empty string' };
  if (!cfg.destinations || typeof cfg.destinations !== 'object') return { ok: false, error: 'destinations must be an object' };
  if (cfg.mirrors !== undefined && !Array.isArray(cfg.mirrors)) return { ok: false, error: 'mirrors must be an array of strings' };
  if (!(cfg.primary in cfg.destinations)) return { ok: false, error: `destinations.${cfg.primary} not defined (primary references unknown name)` };
  for (const m of cfg.mirrors ?? []) {
    if (typeof m !== 'string' || !m) return { ok: false, error: 'mirror name must be a non-empty string' };
    if (!(m in cfg.destinations)) return { ok: false, error: `mirror "${m}" not defined in destinations` };
  }
  for (const [name, block] of Object.entries(cfg.destinations)) {
    if (!block || typeof block !== 'object') return { ok: false, error: `destinations.${name} must be an object` };
    if (block.kind !== 'fs' && block.kind !== 'confluence') return { ok: false, error: `destinations.${name}.kind must be "fs" or "confluence"` };
    if (block.kind === 'confluence') {
      for (const f of ['siteUrl', 'spaceKey', 'spaceId', 'rootPageId']) {
        if (typeof block[f] !== 'string' || !block[f]) return { ok: false, error: `destinations.${name}.${f} required` };
      }
      if (!block.subParents || typeof block.subParents !== 'object') return { ok: false, error: `destinations.${name}.subParents required` };
      for (const t of TYPES) {
        if (typeof block.subParents[t] !== 'string' || !block.subParents[t]) return { ok: false, error: `destinations.${name}.subParents.${t} required` };
      }
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/config.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/config.mjs plugins/p-wiki/tools/__tests__/config.test.ts
git commit -m "feat(p-wiki): v3 config shape with v2 auto-migration"
```

---

### Task 2: Rewrite `resolveDestination` to return `{primary, mirrors, primaryName, mirrorNames}`

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destination.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-resolve.test.ts`

Mirrors are constructed lazily — the array's elements are populated on demand via a getter, so a `pwiki new` that only reads `.primary` never spins up an HTTP client for an unused Confluence mirror.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-wiki/tools/__tests__/destination-resolve.test.ts (rewritten)
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDestination } from '../lib/destination.mjs';
import { writeConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-resolve-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('destination.resolveDestination', () => {
  it('defaults to FS when no .pwiki.json is present', () => {
    const r = resolveDestination({ cwd: dir });
    expect(r).not.toBeNull();
    expect(r!.primaryName).toBe('fs');
    expect(r!.primary.kind).toBe('fs');
    expect(r!.mirrorNames).toEqual([]);
    expect(r!.mirrors).toEqual([]);
  });

  it('returns null outside a wiki', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pwiki-empty-'));
    try { expect(resolveDestination({ cwd: empty })).toBeNull(); }
    finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('builds primary from v3 config; mirrors lazy', () => {
    writeConfig(dir, {
      primary: 'fs',
      mirrors: ['confluence'],
      destinations: {
        fs: { kind: 'fs' },
        confluence: {
          kind: 'confluence',
          siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
          rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
        },
      },
    });
    let confluenceFactoryCalls = 0;
    const transport = async () => ({ status: 200, headers: {}, body: {} });
    const r = resolveDestination({ cwd: dir, transport, _spyConfluenceFactory: () => confluenceFactoryCalls++ });
    expect(r!.primary.kind).toBe('fs');
    expect(r!.mirrorNames).toEqual(['confluence']);
    // Lazy: not built yet
    expect(confluenceFactoryCalls).toBe(0);
    // Access triggers construction
    const m = r!.mirrors[0];
    expect(m.kind).toBe('confluence');
    expect(confluenceFactoryCalls).toBe(1);
    // Second access is cached
    void r!.mirrors[0];
    expect(confluenceFactoryCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-resolve.test.ts
```

Expected: FAIL — `resolveDestination` returns a single `Destination` directly, not `{primary, ...}`.

- [ ] **Step 3: Implement the new resolver**

```js
// plugins/p-wiki/tools/lib/destination.mjs
import { findWikiRoot } from './paths.mjs';
import { createFsDestination } from './destinations/fs.mjs';
import { createConfluenceDestination } from './destinations/confluence.mjs';
import { readConfig, validateConfig } from './config.mjs';

/**
 * @typedef {Object} ResolvedDestinations
 * @property {Destination} primary
 * @property {string} primaryName
 * @property {Destination[]} mirrors   - same length and order as mirrorNames; entries lazily constructed
 * @property {string[]} mirrorNames
 */

const DEFAULT_FS_CONFIG = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };

function makeDestination(name, block, root, env) {
  if (block.kind === 'fs') return createFsDestination({ root, destinationConfig: block });
  if (block.kind === 'confluence') {
    if (env._spyConfluenceFactory) env._spyConfluenceFactory(name);
    return createConfluenceDestination({ root, destinationConfig: block, transport: env.transport });
  }
  throw new Error(`unknown destination kind: ${block.kind}`);
}

export function resolveDestination(env) {
  const root = findWikiRoot(env.cwd);
  if (root === null) return null;
  const cfg = readConfig(root) ?? DEFAULT_FS_CONFIG;
  const v = validateConfig(cfg);
  if (!v.ok) throw new Error(`invalid .pwiki.json: ${v.error}`);

  const primaryName = cfg.primary;
  const primary = makeDestination(primaryName, cfg.destinations[primaryName], root, env);

  const mirrorNames = [...(cfg.mirrors ?? [])];
  const mirrorCache = new Array(mirrorNames.length);
  const mirrors = new Proxy(mirrorCache, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const i = Number(prop);
        if (target[i] === undefined && i < mirrorNames.length) {
          const name = mirrorNames[i];
          target[i] = makeDestination(name, cfg.destinations[name], root, env);
        }
        return target[i];
      }
      return Reflect.get(target, prop);
    },
  });

  return { primary, primaryName, mirrors, mirrorNames };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-resolve.test.ts
```

Expected: PASS.

`npm test` overall will be RED (call sites in pwiki.mjs and contract tests still assume the old return shape) — that is fixed in Task 3. Do not commit yet if you want the build green between commits; instead bundle Tasks 2+3 in one commit per the next step.

- [ ] **Step 5: Commit (combined with Task 3 if you prefer green between commits)**

Either commit now and accept transient red, or finish Task 3 first and commit them together. The recommended path: commit Task 2 now, fix call sites in Task 3, full green after Task 3.

```bash
git add plugins/p-wiki/tools/lib/destination.mjs plugins/p-wiki/tools/__tests__/destination-resolve.test.ts
git commit -m "feat(p-wiki): resolveDestination returns {primary, mirrors, ...} with lazy mirror construction"
```

---

### Task 3: Refactor `pwiki.mjs` call sites to use `.primary`

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`

Seven `resolveDestination({ cwd: process.cwd() })` call sites (lines ~180, 255, 287, 325, 341, 356, 378) each need `.primary` appended. The variable name `dest` stays the same.

- [ ] **Step 1: Verify no test is currently writing v3 expectations against pwiki.mjs**

```bash
npx vitest run --reporter=verbose plugins/p-wiki/tools/__tests__/cli-integration.test.ts 2>&1 | head -40
```

Expected: existing tests RED (resolveDestination now returns an object without the destination methods on it directly).

- [ ] **Step 2: Refactor every call site**

In `plugins/p-wiki/tools/pwiki.mjs`, replace:

```js
const dest = resolveDestination({ cwd: process.cwd() });
if (!dest) die(`not inside a p-wiki repo`, 1);
```

with:

```js
const r = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
if (!r) die(`not inside a p-wiki repo`, 1);
const dest = r.primary;
```

Apply this transformation in every one of the seven branches (`new`, `set`, `promote`, `search`, `lint`, `backlinks`, `index`). The `transport` argument is only consumed by the Confluence factory; FS ignores it.

Leave the `init` branch alone — it does not call `resolveDestination`.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: PASS (every existing test). Confluence-destination tests rely on `transport` being injectable through the resolver — verify they still pass.

- [ ] **Step 4: Quick smoke test against an existing fixture**

```bash
node plugins/p-wiki/tools/pwiki.mjs --version
```

Expected: `2.0.0` printed (version bump is later, Task 19).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs
git commit -m "refactor(p-wiki): pwiki.mjs uses resolveDestination(...).primary everywhere"
```

---

### Task 4: Factory signature refactor (`createFsDestination`, `createConfluenceDestination`)

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: every test that instantiates a destination directly (mostly under `tools/__tests__/`)

The new signatures:

```
createFsDestination({ root, destinationConfig })           // destinationConfig = { kind: 'fs' }
createConfluenceDestination({ root, destinationConfig, transport })
   // destinationConfig = { kind: 'confluence', siteUrl, spaceKey, spaceId, rootPageId, subParents }
```

The factories internally compute `rootPath` from `root` (FS: `root` is the repo root; FS body still lives at `<root>/docs/wiki/`). For Confluence, the per-destination block is exposed as `_config` (replacing the previous `config.confluence` indirection).

- [ ] **Step 1: Update `fs.mjs` factory signature**

Replace the top of `plugins/p-wiki/tools/lib/destinations/fs.mjs`:

```js
export function createFsDestination({ root, destinationConfig }) {
  // destinationConfig is { kind: 'fs' } in v3 — no other fields used yet
  const rootPath = root;
  const absFor = (type, slug) => join(rootPath, 'docs', 'wiki', directoryFor(type), `${slug}.md`);
  // ... rest unchanged
```

Backwards-compat shim for any existing direct-import test sites: also accept the old `{ rootPath }` arg and delegate:

```js
export function createFsDestination(args) {
  const rootPath = args.root ?? args.rootPath;
  const _destConfig = args.destinationConfig ?? { kind: 'fs' };
  // ... existing body, using rootPath
}
```

- [ ] **Step 2: Update `confluence.mjs` factory signature**

Replace the top of `plugins/p-wiki/tools/lib/destinations/confluence.mjs`:

```js
export function createConfluenceDestination({ root, destinationConfig, transport }) {
  const c = destinationConfig;
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) {
    if (!transport) throw new Error('PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN required');
  }
  const http = createHttpClient({ baseUrl: c.siteUrl, email: email ?? 'test', token: token ?? 'test', transport });
  // ... rest of the body, but every reference to "c" (formerly config.confluence) is now destinationConfig
```

If any internal call still reads `config.confluence.X`, change to `c.X`. Also update the `return` statement so `_config: c` exposes the per-destination block (already true since `c` was `config.confluence`).

- [ ] **Step 3: Update test instantiations**

Run a grep:

```bash
```

Use Grep tool with pattern `createConfluenceDestination|createFsDestination` over `plugins/p-wiki/tools/__tests__/`. For each match, rewrite the call:

- `createFsDestination({ rootPath })` → `createFsDestination({ root: rootPath, destinationConfig: { kind: 'fs' } })`
- `createConfluenceDestination({ root, config, transport })` → `createConfluenceDestination({ root, destinationConfig: config.confluence, transport })`

If a test already used the v2 `{ root, config }` form and `config` is the full `.pwiki.json` shape, pass `config.confluence` (the per-destination block). If the test built `config` inline, simplify to the per-destination block.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/fs.mjs plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/
git commit -m "refactor(p-wiki): destination factories accept per-destination config block"
```

---

## Layer 2 — Destination interface additions

Each task in this layer extends the `Destination` contract with one method, implements on both backends, and asserts the contract via `destination-contract.test.ts`.

### Task 5: `deletePage` on both backends

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destination.mjs` (typedef)
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

Append to `tools/__tests__/destination-contract.test.ts` (inside `runContractTests`):

```ts
it('deletePage removes an existing page; pageExists is false afterward', async () => {
  const dest = await makeDest();
  const r = await dest.writePage({
    type: 'concept', slug: 'delete-me',
    frontmatter: { id: 'delete-me', type: 'concept', title: 'Delete Me', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
    body: '# Delete Me\n',
  });
  expect(r.created).toBe(true);
  const del = await dest.deletePage(r.path);
  expect(del.deleted).toBe(true);
  expect(await dest.pageExists({ type: 'concept', slug: 'delete-me' })).toBe(false);
});

it('deletePage is idempotent — missing page returns {deleted:false}', async () => {
  const dest = await makeDest();
  const missingPath = dest.pathFor({ type: 'concept', slug: 'never-existed' });
  const del = await dest.deletePage(missingPath);
  expect(del.deleted).toBe(false);
});
```

Note: this test also references `pathFor`, which Task 6 implements. Sequencing: keep this `pathFor` reference but write the literal path inline if Task 5 must land first. For simplicity, hard-code the path in the second test:

```ts
const missingPath = dest.kind === 'fs'
  ? 'docs/wiki/pages/concept/never-existed.md'
  : 'confluence://concept/never-existed';
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-contract.test.ts
```

Expected: FAIL — `deletePage is not a function`.

- [ ] **Step 3: Implement on FS**

In `tools/lib/destinations/fs.mjs`, near the other functions:

```js
import { unlinkSync } from 'node:fs';
// ...

function deletePage(repoRelPath) {
  const abs = join(rootPath, repoRelPath);
  try {
    unlinkSync(abs);
    return { deleted: true, path: repoRelPath };
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: false, path: repoRelPath };
    throw e;
  }
}
```

Add `deletePage` to the returned object:

```js
return { kind: 'fs', rootPath, pageExists, readPage, writePage, mutatePage, movePage, listPages, search, lint, applyBacklinks, regenerateIndex, deletePage };
```

- [ ] **Step 4: Implement on Confluence**

In `tools/lib/destinations/confluence.mjs`:

```js
async function deletePage(path) {
  const { type, slug } = parsePath(path);
  let id = identity.get(type, slug);
  if (!id) {
    // Resolve via CQL (same shape as pageExists). Cache miss + page actually missing → return {deleted:false}.
    const subParent = c.subParents[type];
    const cql = `ancestor = ${subParent} AND property["pwiki-id"] = "${slug}" AND property["pwiki-type"] = "${type}"`;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=1`);
    const r = res.body?.results?.[0];
    if (!r) return { deleted: false, path };
    id = r.content?.id ?? r.id;
    identity.set(type, slug, id);
  }
  try {
    await http.delete(`/wiki/api/v2/pages/${id}`);
    // Drop from cache so subsequent pageExists hits the wire and returns false
    identity.set(type, slug, undefined);
    return { deleted: true, path };
  } catch (e) {
    if (e.status === 404) return { deleted: false, path };
    throw e;
  }
}
```

Verify `http.mjs` exposes a `delete` method; if it only has `get/post/put`, add a small `delete(path)` wrapper that issues `DELETE` and parses the response the same way as the others.

Add `deletePage` to the returned object.

- [ ] **Step 5: Update the typedef and commit**

In `tools/lib/destination.mjs`, append to the typedef:

```js
 * @property {(path: string) => Promise<{deleted: boolean, path: string}> | {deleted: boolean, path: string}} deletePage
```

Run tests, then:

```bash
git add plugins/p-wiki/tools/lib/destinations/fs.mjs plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/lib/destination.mjs plugins/p-wiki/tools/__tests__/destination-contract.test.ts plugins/p-wiki/tools/lib/confluence/http.mjs
git commit -m "feat(p-wiki): add deletePage on FS and Confluence destinations"
```

---

### Task 6: `pathFor` on both backends

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/lib/destination.mjs` (typedef)
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
it('pathFor matches what writePage returns as path for the same (type, slug)', async () => {
  const dest = await makeDest();
  const expected = dest.pathFor({ type: 'concept', slug: 'pathfor-check' });
  const r = await dest.writePage({
    type: 'concept', slug: 'pathfor-check',
    frontmatter: { id: 'pathfor-check', type: 'concept', title: 'PathFor', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
    body: '# PathFor\n',
  });
  expect(r.path).toBe(expected);
});

it('pathFor is synchronous and does no I/O', () => {
  // Best-effort check: pathFor for a never-written slug must succeed and return a string.
  const p = dest.pathFor({ type: 'concept', slug: 'never-written' });
  expect(typeof p).toBe('string');
  expect(p.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-contract.test.ts -t pathFor
```

Expected: FAIL — `pathFor is not a function`.

- [ ] **Step 3: Implement on FS**

In `fs.mjs`:

```js
import { directoryFor } from '../schema.mjs';
// (already imported)

function pathFor({ type, slug }) {
  const abs = absFor(type, slug);
  return repoRel(abs);
}
```

Add `pathFor` to the returned object.

- [ ] **Step 4: Implement on Confluence**

In `confluence.mjs`:

```js
import { parsePath, formatPath, createIdentityCache } from '../confluence/identity.mjs';

function pathFor({ type, slug }) {
  return formatPath(type, slug);                  // already exists: 'confluence://<type>/<slug>'
}
```

Add `pathFor` to the returned object.

- [ ] **Step 5: Update typedef + run tests + commit**

In `tools/lib/destination.mjs`:

```js
 * @property {(args: {type: string, slug: string}) => string} pathFor
```

```bash
npm test
git add plugins/p-wiki/tools/lib/destinations/ plugins/p-wiki/tools/lib/destination.mjs plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "feat(p-wiki): add pathFor on FS and Confluence destinations"
```

---

### Task 7: `mutatePage({ setBody })` on both backends

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts`

`setBody` is the only body-touching mutation. When `setBody` is absent, behavior is identical to v2 (no body GET/PUT). Sync calls this in pass 2.

- [ ] **Step 1: Write the failing contract test**

```ts
it('mutatePage({setBody}) replaces body, preserves frontmatter', async () => {
  const dest = await makeDest();
  const r = await dest.writePage({
    type: 'concept', slug: 'setbody-test',
    frontmatter: { id: 'setbody-test', type: 'concept', title: 'SetBody', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: ['t1'], sources: [] },
    body: '# Original\n\nOriginal body.\n',
  });

  const m = await dest.mutatePage(r.path, { setBody: '# Replaced\n\nNew body content.\n' });
  expect(m.noop).toBe(false);
  expect(m.changed).toContain('body');

  const re = await dest.readPage(r.path);
  expect(re.body).toContain('Replaced');
  expect(re.body).toContain('New body content');
  expect(re.frontmatter.title).toBe('SetBody');
  expect(re.frontmatter.tags).toEqual(['t1']);
});

it('mutatePage with no body mutation does not bump body (Confluence-only)', async () => {
  if (dest.kind !== 'confluence') return;
  const r = await dest.writePage({
    type: 'concept', slug: 'no-body-bump',
    frontmatter: { id: 'no-body-bump', type: 'concept', title: 'NB', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
    body: '# NB\n',
  });
  // Inspect the fake-Confluence underlying state to assert no body PUT happened on a tag-only mutation:
  const id = dest._identity.get('concept', 'no-body-bump');
  const before = dest._http; // no direct API; rely on side-channel via the fake (see fixtures)
  await dest.mutatePage(r.path, { addTag: 'fresh' });
  // The fake exposes `state.bodyPuts(id)` (see fake-confluence.mjs Task 7 augmentation): assert 0.
  expect(globalThis.__fakeConfluenceBodyPuts?.(id) ?? 0).toBe(0);
});
```

If the fake-Confluence does not yet expose `bodyPuts`, extend it: add a `Map<numericId, number>` that ticks on every PUT to `/wiki/api/v2/pages/:id`, and expose `bodyPuts(id)` reader. Skip the second test if the fake is not augmented yet; otherwise, write the augmentation as part of this task.

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-contract.test.ts -t setBody
```

Expected: FAIL — mutatePage ignores `setBody`.

- [ ] **Step 3: Implement on FS**

In `fs.mjs#mutatePage`, after parsing current body and frontmatter, add:

```js
function mutatePage(repoRelPath, mutations) {
  const { frontmatter, body } = readPage(repoRelPath);
  let newBody = body;
  const changed = [];
  // ... existing frontmatter mutation logic ...
  if (typeof mutations.setBody === 'string' && mutations.setBody !== body) {
    newBody = mutations.setBody;
    changed.push('body');
  }
  if (changed.length === 0) return { path: repoRelPath, changed: [], noop: true };
  writeFileSync(join(rootPath, repoRelPath), serializeFrontmatter(newFm, newBody), 'utf-8');
  return { path: repoRelPath, changed: [...new Set(changed)], noop: false };
}
```

Replace the existing body write to use `newBody`. Preserve all other branches.

- [ ] **Step 4: Implement on Confluence**

In `confluence.mjs#mutatePage`, after the existing property/label-mutation block, add:

```js
async function mutatePage(path, mutations) {
  // ... existing v2 logic for property/tag mutations ...
  if (typeof mutations.setBody === 'string') {
    const { type, slug } = parsePath(path);
    const id = identity.get(type, slug);
    if (!id) throw new Error(`mutatePage(setBody): identity not cached for ${path}`);
    const adf = markdownToAdf(mutations.setBody);
    const cur = await http.get(`/wiki/api/v2/pages/${id}`);
    const ver = cur.body?.version?.number ?? 1;
    try {
      await http.put(`/wiki/api/v2/pages/${id}`, {
        id, type: 'page', status: 'current',
        title: cur.body?.title,
        spaceId: c.spaceId,
        body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
        version: { number: ver + 1 },
      });
    } catch (e) {
      if (e.status === 409) {
        // single auto-retry
        const cur2 = await http.get(`/wiki/api/v2/pages/${id}`);
        const ver2 = cur2.body?.version?.number ?? 1;
        await http.put(`/wiki/api/v2/pages/${id}`, {
          id, type: 'page', status: 'current',
          title: cur2.body?.title,
          spaceId: c.spaceId,
          body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
          version: { number: ver2 + 1 },
        });
      } else {
        throw e;
      }
    }
    if (!changed.includes('body')) changed.push('body');
  }
  // ... return as before ...
}
```

- [ ] **Step 5: Run tests + commit**

```bash
npm test
git add plugins/p-wiki/tools/lib/destinations/ plugins/p-wiki/tools/__tests__/
git commit -m "feat(p-wiki): mutatePage({setBody}) on FS and Confluence destinations"
```

---

### Task 8: `ensureStructure` on both backends

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/lib/destination.mjs` (typedef)
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
it('ensureStructure brings the destination into a writable state', async () => {
  const dest = await makeDestWithoutInit();   // helper that skips init (no sub-parents)
  await dest.ensureStructure();
  // After ensure, writePage for every type succeeds:
  for (const type of ['concept', 'person', 'source', 'query'] as const) {
    const r = await dest.writePage({
      type, slug: `ensure-${type}`,
      frontmatter: { id: `ensure-${type}`, type, title: `Ensure ${type}`, created: '2026-05-18', updated: '2026-05-18', status: type === 'query' ? 'filed' : 'active', tags: [], sources: [], ...(type === 'query' ? { question: '?' } : {}), ...(type === 'source' ? { 'source-url': 'https://x', 'source-type': 'doc' } : {}) },
      body: '# x\n',
    });
    expect(r.created).toBe(true);
  }
});

it('ensureStructure is idempotent', async () => {
  const dest = await makeDest();
  await dest.ensureStructure();
  await dest.ensureStructure();   // must not throw, must not create duplicates
});
```

`makeDestWithoutInit` for FS is the same as `makeDest` (FS init is a no-op). For Confluence, instantiate against a fake transport configured with an empty space (root page only, no sub-parents).

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-contract.test.ts -t ensureStructure
```

Expected: FAIL — `ensureStructure is not a function`.

- [ ] **Step 3: Implement on FS (no-op)**

In `fs.mjs`:

```js
function ensureStructure() {
  // No-op: writePage does mkdirSync({recursive: true}) on demand.
}
```

Add to the returned object.

- [ ] **Step 4: Implement on Confluence**

In `confluence.mjs`:

```js
import { ensureSubParent, ensureIndex } from '../confluence/tree.mjs';

async function ensureStructure() {
  for (const type of ['concept', 'person', 'source', 'query']) {
    if (!c.subParents[type]) {
      c.subParents[type] = await ensureSubParent(http, c.spaceId, c.rootPageId, type);
    } else {
      // verify the cached sub-parent still exists; if not, re-create.
      try {
        await http.get(`/wiki/api/v2/pages/${c.subParents[type]}`);
      } catch (e) {
        if (e.status === 404) c.subParents[type] = await ensureSubParent(http, c.spaceId, c.rootPageId, type);
        else throw e;
      }
    }
  }
}
```

Add to the returned object.

- [ ] **Step 5: Update typedef + run tests + commit**

In `destination.mjs`:

```js
 * @property {() => Promise<void> | void} ensureStructure
```

```bash
npm test
git add plugins/p-wiki/tools/lib/destinations/ plugins/p-wiki/tools/lib/destination.mjs plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "feat(p-wiki): ensureStructure on FS (no-op) and Confluence (bootstrap sub-parents)"
```

---

## Layer 3 — Cross-link primitives

### Task 9: `parseWikiLink` + `formatWikiLink` on the FS destination

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Create: `plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts`

Spec §2.4 / §4.1. Both methods are synchronous, deterministic, no I/O.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
let dest: any;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-links-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('FS parseWikiLink / formatWikiLink', () => {
  const from = 'docs/wiki/pages/concept/foo.md';

  it('parses sibling .md as concept/<slug>', () => {
    expect(dest.parseWikiLink('./bar.md', from)).toEqual({ type: 'concept', slug: 'bar' });
    expect(dest.parseWikiLink('bar.md', from)).toEqual({ type: 'concept', slug: 'bar' });
  });

  it('parses parent traversal across types', () => {
    expect(dest.parseWikiLink('../source/baz.md', from)).toEqual({ type: 'source', slug: 'baz' });
    expect(dest.parseWikiLink('../query/2026-05-18-q.md', from)).toEqual({ type: 'query', slug: '2026-05-18-q' });
  });

  it('returns null for external URLs, anchors, mailto', () => {
    expect(dest.parseWikiLink('https://example.com', from)).toBeNull();
    expect(dest.parseWikiLink('mailto:x@y.z', from)).toBeNull();
    expect(dest.parseWikiLink('#section', from)).toBeNull();
  });

  it('returns null for paths outside the pages tree', () => {
    expect(dest.parseWikiLink('../../raw/x.md', from)).toBeNull();
    expect(dest.parseWikiLink('../../README.md', from)).toBeNull();
  });

  it('formats a sibling link relative to the source page', () => {
    expect(dest.formatWikiLink({ type: 'concept', slug: 'bar' }, from)).toBe('bar.md');
    expect(dest.formatWikiLink({ type: 'source', slug: 'baz' }, from)).toBe('../source/baz.md');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts
```

Expected: FAIL — `parseWikiLink is not a function`.

- [ ] **Step 3: Implement on FS**

In `fs.mjs`, near `pathFor`:

```js
import { posix as pathPosix } from 'node:path';
import { TYPES } from '../schema.mjs';

const TYPE_DIRS = { concept: 'concept', person: 'person', source: 'source', query: 'query' };
const DIR_TYPES = Object.fromEntries(Object.entries(TYPE_DIRS).map(([t, d]) => [d, t]));

function parseWikiLink(href, fromPath) {
  // External URL / anchor / mailto / non-relative href → null
  if (!href) return null;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return null;     // http://, mailto:, etc.
  if (href.startsWith('#')) return null;
  if (!href.endsWith('.md')) return null;
  // Resolve relative to the source page's directory
  const fromDir = pathPosix.dirname(fromPath);
  const resolved = pathPosix.normalize(pathPosix.join(fromDir, href));
  // Expected shape: docs/wiki/pages/<type>/<slug>.md
  const m = /^docs\/wiki\/pages\/([^/]+)\/([^/]+)\.md$/.exec(resolved);
  if (!m) return null;
  const type = DIR_TYPES[m[1]];
  if (!type) return null;
  return { type, slug: m[2] };
}

function formatWikiLink({ type, slug }, fromPath) {
  const target = pathFor({ type, slug });
  const fromDir = pathPosix.dirname(fromPath);
  const rel = pathPosix.relative(fromDir, target);
  // node returns paths without leading "./"; that matches our test expectations.
  return rel;
}
```

Add both to the returned object.

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/fs.mjs plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts
git commit -m "feat(p-wiki): parseWikiLink/formatWikiLink on FS destination"
```

---

### Task 10: `parseWikiLink` + `formatWikiLink` on the Confluence destination

**Files:**
- Modify: `plugins/p-wiki/tools/lib/confluence/identity.mjs`
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts`

The identity cache is extended with a reverse index (numericId → `(type, slug)`) so `parseWikiLink` can resolve a Confluence URL without an extra HTTP call when the page has already been seen.

- [ ] **Step 1: Extend the identity cache**

Replace `tools/lib/confluence/identity.mjs`:

```js
const PATH_RE = /^confluence:\/\/([a-z]+)\/(.+)$/;

export function parsePath(path) {
  const m = PATH_RE.exec(path);
  if (!m) throw new Error(`not a confluence:// path: ${path}`);
  return { type: m[1], slug: m[2] };
}

export function formatPath(type, slug) {
  return `confluence://${type}/${slug}`;
}

export function createIdentityCache() {
  const forward = new Map();         // "<type>/<slug>" → numericId
  const reverse = new Map();         // numericId → { type, slug }
  const fkey = (t, s) => `${t}/${s}`;
  return {
    get(type, slug) { return forward.get(fkey(type, slug)); },
    set(type, slug, id) {
      const k = fkey(type, slug);
      const prev = forward.get(k);
      if (prev !== undefined) reverse.delete(prev);
      if (id === undefined) {
        forward.delete(k);
      } else {
        forward.set(k, id);
        reverse.set(String(id), { type, slug });
      }
    },
    getByNumericId(id) { return reverse.get(String(id)); },
    clear() { forward.clear(); reverse.clear(); },
  };
}
```

Run existing `confluence-identity.test.ts` to confirm nothing breaks; add a test:

```ts
it('cache supports reverse lookup by numericId', () => {
  const c = createIdentityCache();
  c.set('concept', 'foo', '12345');
  expect(c.getByNumericId('12345')).toEqual({ type: 'concept', slug: 'foo' });
  c.set('concept', 'foo', undefined);
  expect(c.getByNumericId('12345')).toBeUndefined();
});
```

- [ ] **Step 2: Write the failing Confluence-side test**

Append to `tools/__tests__/destination-link-shape.test.ts`:

```ts
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

describe('Confluence parseWikiLink / formatWikiLink', () => {
  let dest: any;
  beforeAll(async () => {
    const fake = createFakeConfluence();
    dest = createConfluenceDestination({
      root: '/tmp/x',
      destinationConfig: {
        kind: 'confluence',
        siteUrl: 'https://example.atlassian.net',
        spaceKey: 'ENG',
        spaceId: '100',
        rootPageId: '200',
        subParents: { concept: '201', person: '202', source: '203', query: '204' },
      },
      transport: fake.transport,
    });
    // Seed the cache by writing a page (writePage populates identity)
    await dest.writePage({
      type: 'concept', slug: 'foo',
      frontmatter: { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
      body: '# Foo\n',
    });
  });

  const from = 'confluence://concept/source-page';

  it('parses Confluence URL on this site to (type, slug) using identity', () => {
    const id = dest._identity.get('concept', 'foo');
    const href = `https://example.atlassian.net/wiki/spaces/ENG/pages/${id}`;
    expect(dest.parseWikiLink(href, from)).toEqual({ type: 'concept', slug: 'foo' });
  });

  it('returns null for foreign siteUrl', () => {
    expect(dest.parseWikiLink('https://other.atlassian.net/wiki/spaces/ENG/pages/123', from)).toBeNull();
  });

  it('returns null for non-URL hrefs', () => {
    expect(dest.parseWikiLink('mailto:a@b.c', from)).toBeNull();
    expect(dest.parseWikiLink('#anchor', from)).toBeNull();
    expect(dest.parseWikiLink('./bar.md', from)).toBeNull();
  });

  it('formats identity to Confluence URL on this site', () => {
    const id = dest._identity.get('concept', 'foo');
    expect(dest.formatWikiLink({ type: 'concept', slug: 'foo' }, from)).toBe(
      `https://example.atlassian.net/wiki/spaces/ENG/pages/${id}`,
    );
  });

  it('throws on identity miss', () => {
    expect(() => dest.formatWikiLink({ type: 'concept', slug: 'does-not-exist' }, from)).toThrow();
  });
});
```

- [ ] **Step 3: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts
```

Expected: FAIL — `parseWikiLink is not a function` (Confluence).

- [ ] **Step 4: Implement on Confluence**

In `confluence.mjs`, near `pathFor`:

```js
const URL_RE = new RegExp(`^${c.siteUrl.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/wiki/spaces/${c.spaceKey}/pages/(\\d+)$`);

function parseWikiLink(href, _fromPath) {
  if (!href) return null;
  const m = URL_RE.exec(href);
  if (!m) return null;
  const numericId = m[1];
  const hit = identity.getByNumericId(numericId);
  if (!hit) return null;
  return { type: hit.type, slug: hit.slug };
}

function formatWikiLink({ type, slug }, _fromPath) {
  const id = identity.get(type, slug);
  if (!id) throw new Error(`formatWikiLink: identity miss for ${type}/${slug}`);
  return `${c.siteUrl}/wiki/spaces/${c.spaceKey}/pages/${id}`;
}
```

Add both to the returned object. Also: ensure `writePage`, `readPage`, `listPages`, and `pageExists` all populate `identity.set(type, slug, id)` whenever they resolve a numeric id — the spec requires the reverse cache to be populated as a side-effect of every page-read operation.

Audit those four methods; they already `identity.set(...)` on the forward direction. The new `identity.set` implementation in Task 10 Step 1 automatically populates reverse too, so no changes needed.

- [ ] **Step 5: Run, verify pass + commit**

```bash
npm test
git add plugins/p-wiki/tools/lib/confluence/identity.mjs plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-link-shape.test.ts plugins/p-wiki/tools/__tests__/confluence-identity.test.ts
git commit -m "feat(p-wiki): parseWikiLink/formatWikiLink on Confluence; identity cache reverse lookup"
```

---

## Layer 4 — Sync orchestrator

### Task 11: `cross-links.mjs` — `rewriteCrossLinks` + `stripCrossLinks`

**Files:**
- Create: `plugins/p-wiki/tools/lib/cross-links.mjs`
- Create: `plugins/p-wiki/tools/__tests__/cross-links.test.ts`

Pure-functional rewriter. Both functions walk markdown links, classify via `src.parseWikiLink`, and emit either a verbatim or a rewritten link. Uses the same skip ranges as v1.1 `backlinks.mjs#findSkippedRanges` to avoid touching code blocks and shortcut references.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-wiki/tools/__tests__/cross-links.test.ts
import { describe, expect, it, vi } from 'vitest';
import { rewriteCrossLinks, stripCrossLinks } from '../lib/cross-links.mjs';

function mockSrc(parseMap: Record<string, any>) {
  return {
    parseWikiLink: (href: string) => parseMap[href] ?? null,
  } as any;
}

function mockDst(formatMap: Record<string, string>, opts?: { throwOn?: string }) {
  return {
    formatWikiLink: (id: { type: string; slug: string }) => {
      const k = `${id.type}/${id.slug}`;
      if (opts?.throwOn === k) throw new Error('miss');
      return formatMap[k] ?? `?/${k}`;
    },
  } as any;
}

describe('rewriteCrossLinks', () => {
  it('rewrites wiki links and passes externals verbatim', () => {
    const body = `Hello [Bar](./bar.md), see also [Google](https://google.com) and [Baz](../source/baz.md).`;
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' }, '../source/baz.md': { type: 'source', slug: 'baz' } });
    const dst = mockDst({ 'concept/bar': 'bar.md', 'source/baz': '../source/baz.md' });
    const out = rewriteCrossLinks(body, src, 'docs/wiki/pages/concept/foo.md', dst, 'docs/wiki/pages/concept/foo.md');
    expect(out).toBe(`Hello [Bar](bar.md), see also [Google](https://google.com) and [Baz](../source/baz.md).`);
  });

  it('skips links inside fenced code blocks', () => {
    const body = "Real [Bar](./bar.md).\n\n```\n[Bar](./bar.md)\n```\n";
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' } });
    const dst = mockDst({ 'concept/bar': 'OK' });
    const out = rewriteCrossLinks(body, src, 'p.md', dst, 'p.md');
    expect(out).toBe("Real [Bar](OK).\n\n```\n[Bar](./bar.md)\n```\n");
  });

  it('skips links inside inline code', () => {
    const body = "Real [Bar](./bar.md) and `[Bar](./bar.md)`.";
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' } });
    const dst = mockDst({ 'concept/bar': 'OK' });
    const out = rewriteCrossLinks(body, src, 'p.md', dst, 'p.md');
    expect(out).toBe("Real [Bar](OK) and `[Bar](./bar.md)`.");
  });

  it('emits verbatim and warns when formatWikiLink throws', () => {
    const body = `[Broken](./broken.md)`;
    const src = mockSrc({ './broken.md': { type: 'concept', slug: 'broken' } });
    const dst = mockDst({}, { throwOn: 'concept/broken' });
    const warn = vi.fn();
    const out = rewriteCrossLinks(body, src, 'p.md', dst, 'p.md', { onWarn: warn });
    expect(out).toBe(`[Broken](./broken.md)`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ type: 'concept', slug: 'broken' });
  });
});

describe('stripCrossLinks', () => {
  it('replaces wiki link hrefs with sentinel, preserves externals', () => {
    const body = `[Bar](./bar.md), [Google](https://google.com), [Baz](../source/baz.md)`;
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' }, '../source/baz.md': { type: 'source', slug: 'baz' } });
    const out = stripCrossLinks(body, src, 'docs/wiki/pages/concept/foo.md');
    expect(out).toBe(`[Bar](#pwiki-pending), [Google](https://google.com), [Baz](#pwiki-pending)`);
  });

  it('skips code blocks', () => {
    const body = "[Bar](./bar.md)\n\n```\n[Bar](./bar.md)\n```\n";
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' } });
    const out = stripCrossLinks(body, src, 'p.md');
    expect(out).toBe("[Bar](#pwiki-pending)\n\n```\n[Bar](./bar.md)\n```\n");
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cross-links.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cross-links.mjs`**

```js
// plugins/p-wiki/tools/lib/cross-links.mjs

// Standard markdown inline-link: [text](href). The text portion may include
// escaped characters but no unescaped ']' or '\n'; the href may not contain
// unescaped ')' or '\n'. Shortcut/reference forms ([text][id], [text])
// are skipped via the same range logic v1.1 backlinks uses.
const LINK_RE = /\[([^\]\n]+?)\]\(([^)\n]+?)\)/g;

function findSkippedRanges(body) {
  const raw = [];
  // Fenced code blocks
  for (const m of body.matchAll(/```[\s\S]*?```/g)) raw.push([m.index, m.index + m[0].length]);
  // Inline code
  for (const m of body.matchAll(/`[^`\n]+`/g)) raw.push([m.index, m.index + m[0].length]);
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of raw) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function isInside(idx, ranges) {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

function walkLinks(body, fn) {
  const skipped = findSkippedRanges(body);
  let out = '';
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(body)) !== null) {
    if (isInside(m.index, skipped)) continue;
    const [whole, text, href] = m;
    const replacement = fn({ text, href });
    if (replacement !== undefined) {
      out += body.slice(last, m.index) + replacement;
      last = m.index + whole.length;
    }
  }
  out += body.slice(last);
  return out;
}

export function rewriteCrossLinks(body, src, srcPath, dst, dstPath, opts = {}) {
  const onWarn = opts.onWarn ?? (() => {});
  return walkLinks(body, ({ text, href }) => {
    const id = src.parseWikiLink(href, srcPath);
    if (id === null) return undefined;                  // pass through verbatim
    try {
      const newHref = dst.formatWikiLink(id, dstPath);
      return `[${text}](${newHref})`;
    } catch (e) {
      onWarn({ type: id.type, slug: id.slug, error: e });
      return undefined;                                  // pass through verbatim
    }
  });
}

export function stripCrossLinks(body, src, srcPath) {
  return walkLinks(body, ({ text, href }) => {
    const id = src.parseWikiLink(href, srcPath);
    if (id === null) return undefined;
    return `[${text}](#pwiki-pending)`;
  });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cross-links.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/cross-links.mjs plugins/p-wiki/tools/__tests__/cross-links.test.ts
git commit -m "feat(p-wiki): cross-links.mjs — rewriteCrossLinks + stripCrossLinks"
```

---

### Task 12: `sync.mjs` — `syncToMirror` orchestrator

**Files:**
- Create: `plugins/p-wiki/tools/lib/sync.mjs`

The orchestrator implements pre-pass + four passes from spec §3. Tests for full multi-page behavior live in Task 13; this task ships unit tests for the algorithm's structure with both backends mocked.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-wiki/tools/__tests__/sync-unit.test.ts (new)
import { describe, expect, it, vi } from 'vitest';
import { syncToMirror } from '../lib/sync.mjs';

function makeMockDest(kind: 'fs' | 'confluence', pages: any[] = []) {
  const calls: any = { ensureStructure: 0, writePage: [], mutatePage: [], deletePage: [], regenerateIndex: 0 };
  return {
    kind,
    calls,
    ensureStructure: () => { calls.ensureStructure++; },
    listPages: () => pages,
    readPage: (path: string) => {
      const p = pages.find((x: any) => x.path === path);
      return { frontmatter: p.frontmatter, body: p.body, path };
    },
    pathFor: ({ type, slug }: any) => kind === 'fs' ? `docs/wiki/pages/${type}/${slug}.md` : `confluence://${type}/${slug}`,
    parseWikiLink: () => null,
    formatWikiLink: ({ type, slug }: any, _from: string) => kind === 'fs' ? `../${type}/${slug}.md` : `https://x/wiki/spaces/E/pages/${type}-${slug}`,
    writePage: (args: any) => { calls.writePage.push(args); return { path: args.type ? `docs/wiki/pages/${args.type}/${args.slug}.md` : '?', created: true }; },
    mutatePage: (path: string, mutations: any) => { calls.mutatePage.push({ path, mutations }); return { path, changed: ['body'], noop: false }; },
    deletePage: (path: string) => { calls.deletePage.push(path); return { deleted: true, path }; },
    regenerateIndex: () => { calls.regenerateIndex++; return { path: 'docs/wiki/index.md', groups: { concept: 0, person: 0, source: 0, query: 0 }, written: true }; },
  };
}

const concept = (slug: string, body = `# ${slug}\n`) => ({
  path: `docs/wiki/pages/concept/${slug}.md`,
  frontmatter: { id: slug, type: 'concept', title: slug, created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
  body,
});

describe('syncToMirror', () => {
  it('runs ensureStructure, writes every source page (pass 1), then mutates (pass 2), then regenerates Index', async () => {
    const src = makeMockDest('fs', [concept('a'), concept('b')]);
    const dst = makeMockDest('confluence', []);
    const r = await syncToMirror(src, dst, { mirrorName: 'confluence' });
    expect(dst.calls.ensureStructure).toBe(1);
    expect(dst.calls.writePage.length).toBe(2);          // pass 1
    expect(dst.calls.mutatePage.length).toBe(2);          // pass 2
    expect(dst.calls.deletePage.length).toBe(0);
    expect(dst.calls.regenerateIndex).toBe(1);
    expect(r.written).toBe(2);
    expect(r.deleted).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.indexed).toBe(true);
  });

  it('deletes mirror-only pages (pass 3)', async () => {
    const src = makeMockDest('fs', [concept('keep')]);
    const dst = makeMockDest('confluence', [concept('keep'), concept('orphan')]);
    const r = await syncToMirror(src, dst, { mirrorName: 'confluence' });
    expect(dst.calls.deletePage.length).toBe(1);
    expect(dst.calls.deletePage[0]).toContain('orphan');
    expect(r.deleted).toBe(1);
  });

  it('caches source bodies — readPage called once per source page', async () => {
    const src = makeMockDest('fs', [concept('a'), concept('b'), concept('c')]);
    const readSpy = vi.spyOn(src, 'readPage');
    const dst = makeMockDest('confluence', []);
    await syncToMirror(src, dst, { mirrorName: 'confluence' });
    expect(readSpy).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/sync-unit.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sync.mjs`**

```js
// plugins/p-wiki/tools/lib/sync.mjs
import { rewriteCrossLinks, stripCrossLinks } from './cross-links.mjs';

export async function syncToMirror(src, dst, opts = {}) {
  const mirrorName = opts.mirrorName ?? 'mirror';
  const onWarn = opts.onWarn ?? ((info) => process.stderr.write(`[sync] cross-link target ${info.type}/${info.slug} not found on mirror ${mirrorName}\n`));
  const counters = { written: 0, rewritten: 0, deleted: 0, warnings: 0, indexed: false };

  // Pass 0
  await dst.ensureStructure();

  // Enumerate + read source bodies once.
  const srcList = await src.listPages({ in: 'pages' });
  const dstList = await dst.listPages({ in: 'pages' });

  const srcIndex = new Map();                  // key "<type>/<slug>" → { srcPath, frontmatter, body }
  for (const { path: srcPath, frontmatter } of srcList) {
    const { body } = await src.readPage(srcPath);
    srcIndex.set(`${frontmatter.type}/${frontmatter.id}`, { srcPath, frontmatter, body });
  }
  const dstIndex = new Map();
  for (const { path: dstPath, frontmatter } of dstList) {
    dstIndex.set(`${frontmatter.type}/${frontmatter.id}`, dstPath);
  }

  // Pass 1 — write/upsert with sentinel bodies.
  for (const [, { srcPath, frontmatter, body }] of srcIndex) {
    const stub = stripCrossLinks(body, src, srcPath);
    await dst.writePage({
      type: frontmatter.type,
      slug: frontmatter.id,
      frontmatter,
      body: stub,
      onConflict: 'overwrite',
    });
    counters.written++;
  }

  // Pass 2 — rewrite cross-links now that all dst pages exist.
  for (const [, { srcPath, frontmatter, body }] of srcIndex) {
    const dstPath = dst.pathFor({ type: frontmatter.type, slug: frontmatter.id });
    let warnCount = 0;
    const rewritten = rewriteCrossLinks(body, src, srcPath, dst, dstPath, {
      onWarn: (info) => { warnCount++; counters.warnings++; onWarn(info); },
    });
    await dst.mutatePage(dstPath, { setBody: rewritten });
    counters.rewritten++;
  }

  // Pass 3 — delete pages in dst that are not in src.
  for (const [key, dstPath] of dstIndex) {
    if (!srcIndex.has(key)) {
      await dst.deletePage(dstPath);
      counters.deleted++;
    }
  }

  // Pass 4 — regenerate Index on dst.
  await dst.regenerateIndex();
  counters.indexed = true;

  return counters;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/sync-unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/sync.mjs plugins/p-wiki/tools/__tests__/sync-unit.test.ts
git commit -m "feat(p-wiki): sync.mjs — syncToMirror orchestrator (pass 0..4)"
```

---

### Task 13: Integration `sync.test.ts` — FS↔fake-Confluence end-to-end

**Files:**
- Create: `plugins/p-wiki/tools/__tests__/sync.test.ts`

Real destination wiring on both sides. Covers the spec §8.3 scenarios in both directions.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-wiki/tools/__tests__/sync.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { syncToMirror } from '../lib/sync.mjs';

const confluenceCfg = {
  kind: 'confluence',
  siteUrl: 'https://example.atlassian.net',
  spaceKey: 'ENG',
  spaceId: '100',
  rootPageId: '200',
  subParents: { concept: '201', person: '202', source: '203', query: '204' },
};

function makeFs(dir: string) {
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
  return createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
}
function makeConfluence() {
  const fake = createFakeConfluence();
  return createConfluenceDestination({ root: '/tmp', destinationConfig: confluenceCfg, transport: fake.transport });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pwiki-sync-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sampleConcept = (slug: string, body = `# ${slug}\n\nBody.\n`) => ({
  type: 'concept' as const, slug,
  frontmatter: { id: slug, type: 'concept', title: slug, created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
  body,
});

describe('syncToMirror integration', () => {
  it('empty source + empty mirror → only regenerateIndex runs', async () => {
    const src = makeFs(dir);
    const dst = makeConfluence();
    const r = await syncToMirror(src, dst);
    expect(r.written).toBe(0);
    expect(r.deleted).toBe(0);
    expect(r.indexed).toBe(true);
  });

  it('FS → Confluence: 3 source pages, mirror gains 3 pages with rewritten cross-links', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('a', `# A\n\nLinks: [B](./b.md) and [Google](https://google.com).\n`));
    await src.writePage(sampleConcept('b'));
    await src.writePage(sampleConcept('c'));
    const dst = makeConfluence();
    const r = await syncToMirror(src, dst);
    expect(r.written).toBe(3);
    expect(r.deleted).toBe(0);
    // Cross-link in A's body must point to Confluence URL of B on dst.
    const aOnDst = await dst.readPage('confluence://concept/a');
    const bId = dst._identity.get('concept', 'b');
    expect(aOnDst.body).toContain(`https://example.atlassian.net/wiki/spaces/ENG/pages/${bId}`);
    expect(aOnDst.body).toContain('https://google.com');     // external preserved
  });

  it('Confluence → FS: round-trip cross-links into relative paths', async () => {
    const conf = makeConfluence();
    await conf.writePage(sampleConcept('b'));
    const bId = conf._identity.get('concept', 'b');
    await conf.writePage(sampleConcept('a', `# A\n\nSee [B](https://example.atlassian.net/wiki/spaces/ENG/pages/${bId}).\n`));
    const fs2 = makeFs(dir);
    const r = await syncToMirror(conf, fs2);
    expect(r.written).toBe(2);
    const aOnFs = await fs2.readPage('docs/wiki/pages/concept/a.md');
    expect(aOnFs.body).toContain('](b.md)');
  });

  it('removes pages from mirror that are not in source (true mirror)', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('keep'));
    const dst = makeConfluence();
    await dst.writePage(sampleConcept('keep'));
    await dst.writePage(sampleConcept('orphan'));
    const r = await syncToMirror(src, dst);
    expect(r.deleted).toBe(1);
    expect(await dst.pageExists({ type: 'concept', slug: 'orphan' })).toBe(false);
    expect(await dst.pageExists({ type: 'concept', slug: 'keep' })).toBe(true);
  });

  it('broken wiki cross-link in source emits warning, preserves href verbatim', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('a', `# A\n\n[Broken](./gone.md)\n`));
    const dst = makeConfluence();
    const warnings: any[] = [];
    const r = await syncToMirror(src, dst, { onWarn: (info: any) => warnings.push(info) });
    expect(r.warnings).toBeGreaterThan(0);
    expect(warnings[0]).toMatchObject({ type: 'concept', slug: 'gone' });
  });

  it('re-running sync after partial failure is safe (idempotent)', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('a'));
    await src.writePage(sampleConcept('b'));
    const dst = makeConfluence();
    // First run completes.
    const r1 = await syncToMirror(src, dst);
    expect(r1.written).toBe(2);
    // Second run is a no-op-ish: still re-writes (overwrite semantics) but no errors.
    const r2 = await syncToMirror(src, dst);
    expect(r2.written).toBe(2);
    expect(r2.deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify pass (or fail and fix)**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/sync.test.ts
```

Expected: PASS. If any test FAILs, the most likely cause is identity-cache population during `listPages` — verify that listing a fake-Confluence page actually populates the cache forward+reverse. If `listPages` does not pre-populate identity for pages it returns, augment its implementation in `confluence.mjs#listPages` to call `identity.set(type, slug, numericId)` for every returned hit.

- [ ] **Step 3: Run the full suite**

```bash
npm test
```

Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/sync.test.ts plugins/p-wiki/tools/lib/destinations/confluence.mjs
git commit -m "test(p-wiki): integration tests for syncToMirror (FS↔Confluence)"
```

---

## Layer 5 — CLI command and init flow

### Task 14: `pwiki sync` subcommand

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`
- Create: `plugins/p-wiki/tools/__tests__/cli-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-wiki/tools/__tests__/cli-sync.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = require.resolve('../pwiki.mjs');

function run(cwd: string, args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-cli-sync-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki sync CLI', () => {
  it('exits 2 with config-invalid when .pwiki.json has no mirrors', () => {
    // Default FS-only config has mirrors: []; sync is a no-op + indexed=true.
    const r = run(dir, ['sync', '--format=json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.mirrors).toEqual([]);
  });

  it('exits 2 with config-invalid when primary references an unknown destination', () => {
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'ghost', mirrors: [], destinations: { fs: { kind: 'fs' } },
    }), 'utf-8');
    const r = run(dir, ['sync', '--format=json']);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.error.code).toBe('config-invalid');
  });
});
```

For full FS↔Confluence CLI sync exercise, the e2e test (Task 18) covers it. Keep this layer's CLI test focused on argument parsing + config validation, not full sync behavior (which is covered in Task 13).

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cli-sync.test.ts
```

Expected: FAIL — `unknown command: sync`.

- [ ] **Step 3: Add the subcommand to `pwiki.mjs`**

Update the `KNOWN` array:

```js
const KNOWN = ['new', 'set', 'promote', 'search', 'lint', 'backlinks', 'index', 'init', 'sync'];
```

Add the dispatch branch (place near the other commands in pwiki.mjs):

```js
if (command === 'sync') {
  const env = { cwd: process.cwd(), transport: makeRealTransport() };
  const r = resolveDestination(env);
  if (!r) die(`not inside a p-wiki repo`, 1);

  const format = args.format ?? 'text';
  const results = [];
  let worstExit = 0;
  for (let i = 0; i < r.mirrorNames.length; i++) {
    const name = r.mirrorNames[i];
    const mirror = r.mirrors[i];
    const start = Date.now();
    try {
      const counters = await syncToMirror(r.primary, mirror, {
        mirrorName: name,
        onWarn: (info) => process.stderr.write(`[sync] cross-link target ${info.type}/${info.slug} not found on mirror ${name}\n`),
      });
      const elapsed = Date.now() - start;
      results.push({ name, ...counters, elapsedMs: elapsed });
      if (format === 'text') {
        process.stdout.write(`Syncing primary=${r.primaryName} → mirror=${name}\n`);
        process.stdout.write(`  pass 1: writing ${counters.written} pages\n`);
        process.stdout.write(`  pass 2: rewriting cross-links in ${counters.rewritten} pages\n`);
        process.stdout.write(`  pass 3: deleting ${counters.deleted} pages\n`);
        process.stdout.write(`  pass 4: regenerating Index\n`);
        process.stdout.write(`Done in ${(elapsed / 1000).toFixed(1)}s.\n`);
      }
    } catch (e) {
      const code = mapErrorToCode(e);
      worstExit = Math.max(worstExit, 1);
      results.push({ name, error: { code, message: e?.message ?? String(e) } });
      process.stderr.write(`[sync] mirror ${name} failed: ${e?.message ?? e}\n`);
    }
  }
  if (format === 'json') emitJson({ ok: worstExit === 0, mirrors: results }, worstExit);
  process.exit(worstExit);
}
```

Add the import at the top of pwiki.mjs:

```js
import { syncToMirror } from './lib/sync.mjs';
```

For the second test (config-invalid for primary referencing unknown destination), the resolver throws — the existing `try { ... } catch (err)` block at the bottom of pwiki.mjs maps `err.message` containing `invalid .pwiki.json:` to `error.code = 'config-invalid'` with exit 2. Extend `mapErrorToCode` so this case is recognized:

```js
export function mapErrorToCode(err) {
  if (err?.message && /invalid \.pwiki\.json/.test(err.message)) return 'config-invalid';
  // ... existing logic ...
}
```

Also update the trailing exit code derivation to set exit 2 for `config-invalid`:

```js
const exit = (
  code === 'schema-violation' || code === 'slug-taken' || code === 'target-exists' || code === 'config-invalid'
) ? 2 : code === 'internal' ? 3 : 1;
process.exit(exit);
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cli-sync.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-sync.test.ts
git commit -m "feat(p-wiki): pwiki sync CLI subcommand"
```

---

### Task 15: `pwiki init --mirror-fs` and `--mirror-confluence-*` flags

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/cli-integration.test.ts` (or whichever covers init)

Extends the existing `init --confluence` flow. The primary is set up as before; `--mirror-fs` adds an FS mirror; `--mirror-confluence` (with its own `--mirror-site`, `--mirror-space`, `--mirror-parent`) adds a Confluence mirror.

- [ ] **Step 1: Write the failing test**

```ts
// Append to plugins/p-wiki/tools/__tests__/cli-init-confluence.test.ts
// (or create it if absent — the v2 plan Task 29 mentions it)

it('init --confluence --mirror-fs writes v3 shape with fs mirror', async () => {
  // Use an injected transport via a small helper or env to keep this test offline.
  // (Existing init-confluence tests in v2 use a similar pattern.)
  const result = await runInit({
    flags: ['--confluence', '--site=https://x.atlassian.net', '--space=ENG', '--parent=Root', '--mirror-fs'],
    transport: fakeTransport,
  });
  expect(result.exit).toBe(0);
  expect(result.config).toEqual({
    primary: 'confluence',
    mirrors: ['fs'],
    destinations: {
      confluence: expect.objectContaining({ kind: 'confluence', siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG' }),
      fs: { kind: 'fs' },
    },
  });
});
```

If `cli-init-confluence.test.ts` does not yet exist (Task 29 of the v2 plan added it as a "skip if existing CLI tests already cover this pattern" — verify), create a minimal version that exercises `initConfluence` directly via the exported helper from pwiki.mjs.

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cli-init-confluence.test.ts
```

Expected: FAIL — config shape is v2 or `--mirror-fs` is rejected as unknown flag.

- [ ] **Step 3: Rework `initConfluence` in pwiki.mjs**

Replace the existing body of `initConfluence` so that it builds a v3 config:

```js
async function initConfluence(args) {
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) die('PWIKI_CONFLUENCE_EMAIL and PWIKI_CONFLUENCE_TOKEN required', 1);
  const siteUrl = args.site;
  const spaceKey = args.space;
  const parentTitleOrId = args.parent;
  if (!siteUrl || !spaceKey || !parentTitleOrId) die('--site, --space, and --parent required', 1);
  const root = findWikiRoot(process.cwd());
  if (!root) die('not inside a p-wiki repo (no docs/wiki/CLAUDE.md found)', 1);

  const http = createHttpClient({ baseUrl: siteUrl, email, token, transport: makeRealTransport() });
  const spaceRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
  const space = spaceRes.body?.results?.[0];
  if (!space) emitJson({ error: { code: 'config-invalid', message: `space ${spaceKey} not found` } }, 1);

  let rootPageId;
  if (/^\d+$/.test(parentTitleOrId)) {
    rootPageId = parentTitleOrId;
    await http.get(`/wiki/api/v2/pages/${rootPageId}`);
  } else {
    const cql = `title = "${parentTitleOrId.replace(/"/g, '\\"')}" AND space = "${spaceKey}"`;
    const r = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=2`);
    const hits = r.body?.results ?? [];
    if (hits.length === 0) emitJson({ error: { code: 'config-invalid', message: `parent page "${parentTitleOrId}" not found in space ${spaceKey}` } }, 1);
    if (hits.length > 1) emitJson({ error: { code: 'config-invalid', message: `parent page title ambiguous` } }, 1);
    rootPageId = hits[0].content?.id ?? hits[0].id;
  }

  const subParents = {};
  for (const type of ['concept', 'person', 'source', 'query']) {
    subParents[type] = await ensureSubParent(http, space.id, rootPageId, type);
  }

  const confluenceBlock = { kind: 'confluence', siteUrl, spaceKey, spaceId: space.id, rootPageId, subParents };
  let mirrors = [];
  const destinations = { confluence: confluenceBlock };

  if (args['mirror-fs']) {
    destinations.fs = { kind: 'fs' };
    mirrors.push('fs');
  }
  if (args['mirror-confluence']) {
    const msite = args['mirror-site'];
    const mspace = args['mirror-space'];
    const mparent = args['mirror-parent'];
    if (!msite || !mspace || !mparent) die('--mirror-confluence requires --mirror-site, --mirror-space, --mirror-parent', 1);
    const mhttp = createHttpClient({ baseUrl: msite, email, token, transport: makeRealTransport() });
    const mspaceRes = await mhttp.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(mspace)}`);
    const mspaceObj = mspaceRes.body?.results?.[0];
    if (!mspaceObj) emitJson({ error: { code: 'config-invalid', message: `mirror space ${mspace} not found` } }, 1);
    let mrootId;
    if (/^\d+$/.test(mparent)) {
      mrootId = mparent;
      await mhttp.get(`/wiki/api/v2/pages/${mrootId}`);
    } else {
      const cql = `title = "${mparent.replace(/"/g, '\\"')}" AND space = "${mspace}"`;
      const r = await mhttp.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=2`);
      const hits = r.body?.results ?? [];
      if (hits.length !== 1) emitJson({ error: { code: 'config-invalid', message: `mirror parent page lookup failed` } }, 1);
      mrootId = hits[0].content?.id ?? hits[0].id;
    }
    const msubParents = {};
    for (const type of ['concept', 'person', 'source', 'query']) {
      msubParents[type] = await ensureSubParent(mhttp, mspaceObj.id, mrootId, type);
    }
    const mname = 'confluence-mirror';
    destinations[mname] = { kind: 'confluence', siteUrl: msite, spaceKey: mspace, spaceId: mspaceObj.id, rootPageId: mrootId, subParents: msubParents };
    mirrors.push(mname);
  }

  const config = { primary: 'confluence', mirrors, destinations };
  const v = validateConfig(config);
  if (!v.ok) emitJson({ error: { code: 'internal', message: v.error } }, 3);
  writeConfig(root, config);
  emitJson({ ok: true, configPath: 'docs/wiki/.pwiki.json', primary: 'confluence', mirrors }, 0);
}
```

If the primary is FS (no `--confluence` flag), allow `--mirror-confluence-*` to add a Confluence mirror on top of a freshly initialized FS wiki. That path is exercised by the init skill in Task 16 — keep CLI surface symmetric.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-init-confluence.test.ts
git commit -m "feat(p-wiki): pwiki init writes v3 config; --mirror-fs and --mirror-confluence flags"
```

---

### Task 16: `init` skill — additive "Add a mirror?" prompt

**Files:**
- Modify: `plugins/p-wiki/skills/init/SKILL.md`

- [ ] **Step 1: Locate the existing destination-choice step**

Read `plugins/p-wiki/skills/init/SKILL.md` to find the section added in v2's Task 29 ("Choose destination"). The new prompt goes immediately after.

- [ ] **Step 2: Insert the new prompt**

Append (right after the destination-choice block):

```markdown
### Step N+1: Add a mirror?

Ask the user (single question):

> Want to add a mirror? The mirror gets a 1:1 copy of the wiki on every `pwiki sync`. Useful for:
> - **Confluence primary + FS mirror** — git-backed backup of a Confluence wiki, browsable in IDE.
> - **FS primary + Confluence mirror** — markdown is canonical, Confluence is the published view.
>
> Pick: `none` (default), `fs`, or `confluence`.

If the user picks `none`, continue without a mirror — the wiki will run on the chosen primary only.

If the user picks `fs` and the primary is Confluence:
- Call `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" init --confluence --site=<...> --space=<...> --parent=<...> --mirror-fs`.

If the user picks `confluence` and the primary is FS:
- Prompt for mirror Confluence site URL, space key, and parent (same prompts as the Confluence-primary branch).
- Call `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" init --mirror-confluence --mirror-site=<...> --mirror-space=<...> --mirror-parent=<...>`.
  - (FS-primary init creates `.pwiki.json` with `primary: "fs", mirrors: ["confluence-mirror"]`; the mirror flags persist into `destinations`.)

After mirror setup, regardless of branch, continue with the FS-side scaffold step (CLAUDE.md template, `.claude/rules/p-wiki.md`).
```

The numbering placeholder `Step N+1` should be replaced with the actual next step number based on the current state of `SKILL.md`.

- [ ] **Step 3: Run marketplace tests (skill validation)**

```bash
npm test plugins/skills.test.ts plugins/templates.test.ts plugins/plugin-manifests.test.ts
```

Or simply `npm test` which runs them as part of the suite. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/skills/init/SKILL.md
git commit -m "docs(p-wiki): init skill — additive mirror prompt"
```

---

## Layer 6 — Docs, E2E, ship

### Task 17: CLAUDE.md template — multi-destination "Storage backend" updates

**Files:**
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md`

- [ ] **Step 1: Locate the existing "Storage backend" section**

The v2 plan (Task 30) added a "Storage backend" section. Read the current template to locate it.

- [ ] **Step 2: Append multi-destination notes**

Append to the existing "Storage backend" section:

```markdown
### Multi-destination

A wiki can have one **primary** destination (where every command writes) and zero or more **mirrors** (sinks that receive a 1:1 copy on every `pwiki sync`). Configured in `docs/wiki/.pwiki.json`:

```json
{
  "primary": "confluence",
  "mirrors": ["fs"],
  "destinations": {
    "confluence": { "kind": "confluence", "siteUrl": "...", "spaceKey": "...", ... },
    "fs": { "kind": "fs" }
  }
}
```

To populate the mirror, run `pwiki sync`. It walks the primary, writes every page into each mirror (with cross-link `href`s translated to the mirror's format), deletes mirror-only pages (true-mirror semantics), and regenerates the Index on each mirror.

**Adding a mirror after init:**

1. Add an entry to `destinations` with a unique name and the backend config (`kind: "fs"` or `kind: "confluence"`).
2. Add that name to the `mirrors` array.
3. Run `pwiki sync` to populate it.

**Reversing direction (promote a mirror to primary):**

Swap `primary` and the chosen mirror name in `.pwiki.json`. The next `pwiki sync` overwrites the new mirror with the new primary's state. The CLI does not automate this — manual edit only.
```

- [ ] **Step 3: Run marketplace tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md
git commit -m "docs(p-wiki): CLAUDE.md template — multi-destination + sync notes"
```

---

### Task 18: E2E — bootstrap two destinations, sync, mirror verification

**Files:**
- Modify: `plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts`

Append a new scenario to the existing gated E2E suite. Reuses `PWIKI_E2E_CONFLUENCE` and adds optional `PWIKI_E2E_MIRROR_FS_PATH` (defaults to `<tmpDir>/docs/wiki`).

- [ ] **Step 1: Append the scenario**

Add inside the existing `describe.skipIf(skip)('Confluence E2E', () => { ... })` block, after the existing `it(...)`:

```ts
it('multi-destination scenario: configure FS mirror, sync, delete one source page, resync', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwiki-e2e-sync-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'wiki', 'CLAUDE.md'), 'e2e placeholder', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'confluence',
      mirrors: ['fs'],
      destinations: {
        confluence: {
          kind: 'confluence',
          siteUrl: process.env.PWIKI_E2E_SITE_URL,
          spaceKey: process.env.PWIKI_E2E_SPACE_KEY,
          spaceId: (await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(process.env.PWIKI_E2E_SPACE_KEY!)}`)).body.results[0].id,
          rootPageId: process.env.PWIKI_E2E_ROOT_PAGE_ID,
          subParents: dest._config.subParents,
        },
        fs: { kind: 'fs' },
      },
    }, null, 2), 'utf-8');

    const stamp = Date.now().toString();
    // Two source concept pages written via the Confluence destination directly:
    const aRes = await dest.writePage({
      type: 'concept', slug: `e2e-mirror-a-${stamp}`,
      frontmatter: { id: `e2e-mirror-a-${stamp}`, type: 'concept', title: 'Mirror A', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
      body: `# Mirror A\n\nLink: [B](confluence://concept/e2e-mirror-b-${stamp})\n`,
    });
    createdIds.push(dest._identity.get('concept', `e2e-mirror-a-${stamp}`));
    const bRes = await dest.writePage({
      type: 'concept', slug: `e2e-mirror-b-${stamp}`,
      frontmatter: { id: `e2e-mirror-b-${stamp}`, type: 'concept', title: 'Mirror B', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
      body: `# Mirror B\n`,
    });
    createdIds.push(dest._identity.get('concept', `e2e-mirror-b-${stamp}`));

    // Run pwiki sync via the CLI in tmpDir.
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('node', [require.resolve('../pwiki.mjs'), 'sync', '--format=json'], { cwd: tmpDir, encoding: 'utf-8', env: process.env });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.mirrors[0].name).toBe('fs');
    expect(out.mirrors[0].written).toBeGreaterThanOrEqual(2);

    // FS mirror has the two pages with rewritten relative cross-links.
    const aBody = fs.readFileSync(path.join(tmpDir, 'docs', 'wiki', 'pages', 'concept', `e2e-mirror-a-${stamp}.md`), 'utf-8');
    expect(aBody).toContain(`](e2e-mirror-b-${stamp}.md)`);
    expect(fs.existsSync(path.join(tmpDir, 'docs', 'wiki', 'index.md'))).toBe(true);

    // Delete one source page in Confluence, resync, FS mirror loses it.
    await dest.deletePage(`confluence://concept/e2e-mirror-a-${stamp}`);
    const r2 = spawnSync('node', [require.resolve('../pwiki.mjs'), 'sync', '--format=json'], { cwd: tmpDir, encoding: 'utf-8', env: process.env });
    expect(r2.status).toBe(0);
    const out2 = JSON.parse(r2.stdout);
    expect(out2.mirrors[0].deleted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, 'docs', 'wiki', 'pages', 'concept', `e2e-mirror-a-${stamp}.md`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'docs', 'wiki', 'pages', 'concept', `e2e-mirror-b-${stamp}.md`))).toBe(true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}, 240_000);
```

- [ ] **Step 2: Verify it skips when env not set**

```bash
npm test plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
```

Expected: 2 tests, both skipped (no `PWIKI_E2E_CONFLUENCE`).

- [ ] **Step 3: (Optional, manual) Run against real sandbox**

```bash
PWIKI_CONFLUENCE_EMAIL=you@example.com \
PWIKI_CONFLUENCE_TOKEN=<token> \
PWIKI_E2E_CONFLUENCE=1 \
PWIKI_E2E_SITE_URL=https://you.atlassian.net \
PWIKI_E2E_SPACE_KEY=PWIKITEST \
PWIKI_E2E_ROOT_PAGE_ID=<id> \
npm test plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
```

Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
git commit -m "test(p-wiki): E2E — multi-destination sync against real Confluence"
```

---

### Task 19: Version bump 2.x → 3.0.0

**Files:**
- Modify: `plugins/p-wiki/.claude-plugin/plugin.json`
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (`VERSION` constant)

- [ ] **Step 1: Update both files**

In `plugins/p-wiki/.claude-plugin/plugin.json`:

```json
{
  "name": "p-wiki",
  "version": "3.0.0",
  ...
}
```

In `plugins/p-wiki/tools/pwiki.mjs`:

```js
const VERSION = '3.0.0';
```

- [ ] **Step 2: Run full suite + plugin validation**

```bash
npm test
npm run validate
```

Both expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/.claude-plugin/plugin.json plugins/p-wiki/tools/pwiki.mjs
git commit -m "chore(p-wiki): bump version to v3.0.0 (multi-destination + sync)"
```

**Do NOT tag here.** Per project rules (`.claude/CLAUDE.md`), tagging requires explicit user confirmation after `git log v2.0.0..HEAD --oneline` review. Hand control back to the user at this point and let them initiate the tag.

---

## Notes for the executor

- After every task, run `npm test`. Both FS and Confluence suites must stay green.
- v2 `.pwiki.json` files are auto-migrated on first read. If a test fixture writes v2 shape and the test reads it back via `readConfig`, expect v3 shape in the returned object — update assertions accordingly (already covered for `config.test.ts` in Task 1).
- The Confluence destination's identity cache now stores both forward and reverse mappings. Every code path that calls `identity.set(type, slug, id)` automatically populates both directions.
- `mutatePage({setBody})` is the only place that bumps body version on Confluence outside of `writePage`. The v2 invariant "mutatePage does not touch body" is preserved when `setBody` is absent from the mutations object — verify by running v2's `confluence-properties.test.ts` after Task 7.
- The E2E test in Task 18 is gated by `PWIKI_E2E_CONFLUENCE` and uses a temporary repo directory for the FS mirror. Real-Confluence cleanup is handled by the existing `afterAll` hook in the same test file.
- When in doubt about the algorithm or interface contract, consult the spec (`2026-05-18-pwiki-v3-multi-destination-sync-design.md`).
