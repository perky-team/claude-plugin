# p-wiki git/HTTP read-only source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only source that reads a shared p-wiki hosted on GitLab/GitHub (or any static HTTP host) as a single published `index.json` bundle, unioned into `search`/`query`/`get` alongside the local wiki — no local clone, no cache.

**Architecture:** New `kind`s `gitlab`/`github`/`http` in `destinations`, usable only in `sources`. A single generic reader (`http-bundle.mjs`) fetches one bundle via the injected `transport`, decodes it, and serves `search`/`readPage` from it — the exact contract the existing sources union already invokes. Publishing is a new `reindex` command that writes `docs/wiki/index.json` beside `index.md`; `git push` publishes. Additive to the Confluence `mirrors`/`sync` path.

**Tech Stack:** Node ESM (`.mjs`), vitest (`tools/__tests__/*.test.ts`), injected `transport(req) → {status, headers, body}` seam. No new dependencies.

**Spec:** `plugins/p-wiki/docs/superpowers/specs/2026-07-01-pwiki-git-http-source-design.md`

## Global Constraints

- Target version: p-wiki `4.11.0 → 4.12.0` (minor, additive).
- The new kinds (`gitlab`/`github`/`http`) are **source-only** — rejected as `primary` or in `mirrors`.
- Auth tokens are read **only** from env vars (`PWIKI_GITLAB_TOKEN`, `PWIKI_GITHUB_TOKEN`, or the `http` block's `authTokenEnv`); a block carrying an inline token is `config-invalid`.
- The reader is read-only: it implements exactly `search`, `readPage`, `kind` — nothing else.
- The reader calls the injected `transport` **directly** (never `createHttpClient`, which hardcodes Confluence Basic auth), checks `res.status` itself (transport does not throw on non-2xx), and throws an `err.status`-carrying error so `mapErrorToCode` classifies it.
- `github`/`gitlab` use the **JSON file-content endpoints** (`{content, encoding:"base64"}`, `application/json`) so the existing transport's JSON-body path applies; `http` requires the host to serve `application/json`.
- Bundle contains `pages/` only (never `raw/`). Bundle `schema` is `1`.
- No new npm dependencies (base64 via `Buffer`).

---

### Task 1: Config validation for the new kinds

**Files:**
- Modify: `plugins/p-wiki/tools/lib/config.mjs` (`validateConfig`, the per-destination loop ~lines 50-66)
- Test: `plugins/p-wiki/tools/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `validateConfig(cfg) → { ok: true } | { ok: false, error }` (existing).
- Produces: acceptance of `gitlab`/`github`/`http` destination blocks; rejection when such a kind is `primary`/a mirror, or carries an inline `token`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to config.test.ts
import { validateConfig } from '../lib/config.mjs';

describe('validateConfig — git/http source kinds', () => {
  const base = (dest: any) => ({ primary: 'fs', mirrors: [], sources: ['s'], destinations: { fs: { kind: 'fs' }, s: dest } });

  it('accepts a valid gitlab source block', () => {
    expect(validateConfig(base({ kind: 'gitlab', project: 'g/p' })).ok).toBe(true);
  });
  it('accepts a valid github source block', () => {
    expect(validateConfig(base({ kind: 'github', owner: 'o', repo: 'r' })).ok).toBe(true);
  });
  it('accepts a valid http source block', () => {
    expect(validateConfig(base({ kind: 'http', url: 'https://x/index.json' })).ok).toBe(true);
    expect(validateConfig(base({ kind: 'http', url: 'https://x/index.json', authHeader: 'X-Tok', authTokenEnv: 'T' })).ok).toBe(true);
  });
  it('rejects gitlab without project', () => {
    expect(validateConfig(base({ kind: 'gitlab' })).ok).toBe(false);
  });
  it('rejects github without owner/repo', () => {
    expect(validateConfig(base({ kind: 'github', owner: 'o' })).ok).toBe(false);
  });
  it('rejects http with authHeader but no authTokenEnv', () => {
    expect(validateConfig(base({ kind: 'http', url: 'https://x', authHeader: 'X-Tok' })).ok).toBe(false);
  });
  it('rejects an inline token', () => {
    expect(validateConfig(base({ kind: 'gitlab', project: 'g/p', token: 'secret' })).ok).toBe(false);
  });
  it('rejects a source kind used as primary', () => {
    const cfg = { primary: 'g', mirrors: [], destinations: { g: { kind: 'gitlab', project: 'g/p' } } };
    expect(validateConfig(cfg).ok).toBe(false);
  });
  it('rejects a source kind used as a mirror', () => {
    const cfg = { primary: 'fs', mirrors: ['g'], destinations: { fs: { kind: 'fs' }, g: { kind: 'gitlab', project: 'g/p' } } };
    expect(validateConfig(cfg).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/config.test.ts`
Expected: FAIL — current code returns `kind must be "fs" or "confluence"` for the new kinds.

- [ ] **Step 3: Implement the validation**

In `config.mjs`, replace the kind guard and add per-kind checks + the role rule. The destination loop becomes:

```js
const SOURCE_ONLY = new Set(['gitlab', 'github', 'http']);
const writeRolesSet = new Set([cfg.primary, ...(cfg.mirrors ?? [])]);
for (const [name, block] of Object.entries(cfg.destinations)) {
  if (!block || typeof block !== 'object') return { ok: false, error: `destinations.${name} must be an object` };
  const kinds = ['fs', 'confluence', 'gitlab', 'github', 'http'];
  if (!kinds.includes(block.kind)) return { ok: false, error: `destinations.${name}.kind must be one of ${kinds.join(', ')}` };
  if (SOURCE_ONLY.has(block.kind) && writeRolesSet.has(name)) {
    return { ok: false, error: `destinations.${name}.kind "${block.kind}" is read-only and cannot be primary or a mirror` };
  }
  if ('token' in block) return { ok: false, error: `destinations.${name}: inline token forbidden — use an env var` };
  if (block.kind === 'confluence') { /* ...unchanged... */ }
  if (block.kind === 'fs' && block.path !== undefined && (typeof block.path !== 'string' || !block.path)) {
    return { ok: false, error: `destinations.${name}.path must be a non-empty string` };
  }
  if (block.kind === 'gitlab' && (typeof block.project !== 'string' || !block.project)) {
    return { ok: false, error: `destinations.${name}.project required` };
  }
  if (block.kind === 'github') {
    for (const f of ['owner', 'repo']) if (typeof block[f] !== 'string' || !block[f]) return { ok: false, error: `destinations.${name}.${f} required` };
  }
  if (block.kind === 'http') {
    if (typeof block.url !== 'string' || !block.url) return { ok: false, error: `destinations.${name}.url required` };
    if ((block.authHeader === undefined) !== (block.authTokenEnv === undefined)) {
      return { ok: false, error: `destinations.${name}: authHeader and authTokenEnv must be set together` };
    }
  }
}
```

(Keep the existing `confluence` field checks inside the `confluence` branch unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/config.mjs plugins/p-wiki/tools/__tests__/config.test.ts
git commit -m "feat(p-wiki): validate gitlab/github/http source config blocks"
```

---

### Task 2: The HTTP bundle reader

**Files:**
- Create: `plugins/p-wiki/tools/lib/destinations/http-bundle.mjs`
- Test: `plugins/p-wiki/tools/__tests__/http-bundle.test.ts`

**Interfaces:**
- Consumes: `rankDocuments` from `../search.mjs`; the injected `transport(req) → {status, headers, body}`.
- Produces: `createHttpBundleSource({ kind, destinationConfig, transport, env }) → { kind, search(query, opts), readPage(repoRelPath) }`. `search` returns `{ total, results }` (results: `{ path, frontmatter, body, snippet? }`); `readPage` returns `{ frontmatter, body, path }` or throws `Error("page not found: <path>")`.

- [ ] **Step 1: Write the failing tests**

```ts
// http-bundle.test.ts
import { describe, expect, it } from 'vitest';
import { createHttpBundleSource } from '../lib/destinations/http-bundle.mjs';

const BUNDLE = {
  schema: 1, generated: '2026-07-01', wikiRoot: 'docs/wiki',
  pages: [{
    type: 'concept', id: 'kafka', path: 'docs/wiki/pages/concept/kafka.md',
    frontmatter: { id: 'kafka', type: 'concept', title: 'Kafka', tags: ['infra'] },
    body: '# Kafka\n\nStreaming platform.',
  }],
};
const b64 = (o: any) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64');

// gitlab/github wrap the bundle as {content, encoding:"base64"} in a JSON body
const okGitJson = async () => ({ status: 200, headers: {}, body: { content: b64(BUNDLE), encoding: 'base64' } });
// http serves the parsed bundle object directly
const okHttp = async () => ({ status: 200, headers: {}, body: BUNDLE });

describe('createHttpBundleSource', () => {
  it('gitlab: base64-decodes the JSON body and searches', async () => {
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: okGitJson, env: {} });
    const r = await src.search('kafka', {});
    expect(r.results[0].path).toBe('docs/wiki/pages/concept/kafka.md');
  });
  it('http: uses the parsed body object directly and reads a page', async () => {
    const src = createHttpBundleSource({ kind: 'http', destinationConfig: { kind: 'http', url: 'https://x/index.json' }, transport: okHttp, env: {} });
    const p = await src.readPage('docs/wiki/pages/concept/kafka.md');
    expect(p.frontmatter.title).toBe('Kafka');
  });
  it('readPage throws page-not-found for a missing path', async () => {
    const src = createHttpBundleSource({ kind: 'http', destinationConfig: { kind: 'http', url: 'https://x' }, transport: okHttp, env: {} });
    await expect(src.readPage('docs/wiki/pages/concept/nope.md')).rejects.toThrow(/page not found/);
  });
  it('non-2xx throws an err.status-carrying error', async () => {
    const failing = async () => ({ status: 404, headers: {}, body: null });
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: failing, env: {} });
    await expect(src.search('x', {})).rejects.toMatchObject({ status: 404 });
  });
  it('malformed bundle throws err.code=bundle-invalid', async () => {
    const bad = async () => ({ status: 200, headers: {}, body: { content: Buffer.from('not json', 'utf-8').toString('base64'), encoding: 'base64' } });
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: bad, env: {} });
    await expect(src.search('x', {})).rejects.toMatchObject({ code: 'bundle-invalid' });
  });
  it('attaches the auth header only when the env token is set', async () => {
    let seen: any;
    const spy = async (req: any) => { seen = req.headers; return okGitJson(); };
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: spy, env: { PWIKI_GITLAB_TOKEN: 'tok' } });
    await src.search('kafka', {});
    expect(seen['PRIVATE-TOKEN']).toBe('tok');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/http-bundle.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the reader**

```js
// plugins/p-wiki/tools/lib/destinations/http-bundle.mjs
import { rankDocuments } from '../search.mjs';

const stripSlash = (s) => String(s).replace(/\/+$/, '');
const enc = encodeURIComponent;

const PROFILES = {
  gitlab: {
    url: (c) => `${stripSlash(c.baseUrl ?? 'https://gitlab.com')}/api/v4/projects/${enc(c.project)}/repository/files/${enc(c.indexPath ?? 'docs/wiki/index.json')}?ref=${enc(c.ref ?? 'main')}`,
    header: (c, env) => { const t = env[c.tokenEnv ?? 'PWIKI_GITLAB_TOKEN']; return t ? { 'PRIVATE-TOKEN': t } : {}; },
    base64: true,
  },
  github: {
    url: (c) => `${stripSlash(c.apiBaseUrl ?? 'https://api.github.com')}/repos/${c.owner}/${c.repo}/contents/${c.indexPath ?? 'docs/wiki/index.json'}${c.ref ? `?ref=${enc(c.ref)}` : ''}`,
    header: (c, env) => { const t = env[c.tokenEnv ?? 'PWIKI_GITHUB_TOKEN']; return t ? { Authorization: `Bearer ${t}` } : {}; },
    base64: true,
  },
  http: {
    url: (c) => c.url,
    header: (c, env) => { if (!c.authHeader) return {}; const t = env[c.authTokenEnv]; return t ? { [c.authHeader]: t } : {}; },
    base64: false,
  },
};

export function createHttpBundleSource({ kind, destinationConfig, transport, env = process.env }) {
  const profile = PROFILES[kind];
  if (!profile) throw new Error(`unknown http-bundle kind: ${kind}`);
  const c = destinationConfig;

  async function fetchBundle() {
    const req = { method: 'GET', url: profile.url(c), headers: { Accept: 'application/json', ...profile.header(c, env) } };
    const res = await transport(req);
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`HTTP ${res.status} GET ${req.url}`);
      err.status = res.status;
      throw err;
    }
    let bundle;
    try {
      if (profile.base64) {
        const text = Buffer.from(res.body?.content ?? '', res.body?.encoding ?? 'base64').toString('utf-8');
        bundle = JSON.parse(text);
      } else {
        bundle = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      }
    } catch {
      const err = new Error('bundle is not valid JSON'); err.code = 'bundle-invalid'; throw err;
    }
    if (!bundle || bundle.schema !== 1 || !Array.isArray(bundle.pages)) {
      const err = new Error('bundle schema unsupported'); err.code = 'bundle-invalid'; throw err;
    }
    return bundle;
  }

  async function search(query, opts = {}) {
    const bundle = await fetchBundle();
    let docs = bundle.pages.map(p => ({ path: p.path, frontmatter: p.frontmatter, body: p.body }));
    if (opts.type?.length) docs = docs.filter(d => opts.type.includes(d.frontmatter.type));
    if (opts.tags?.length) docs = docs.filter(d => (d.frontmatter.tags ?? []).some(t => opts.tags.includes(t)));
    const results = rankDocuments(query, docs, { limit: opts.limit ?? 10, snippet: opts.snippet ?? true });
    return { total: results.length, results };
  }

  async function readPage(repoRelPath) {
    const bundle = await fetchBundle();
    const page = bundle.pages.find(p => p.path === repoRelPath);
    if (!page) throw new Error(`page not found: ${repoRelPath}`);
    return { frontmatter: page.frontmatter, body: page.body, path: page.path };
  }

  return { kind, search, readPage };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/http-bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/http-bundle.mjs plugins/p-wiki/tools/__tests__/http-bundle.test.ts
git commit -m "feat(p-wiki): read-only http-bundle source reader (gitlab/github/http)"
```

---

### Task 3: Wire the reader into resolution + mapErrorToCode

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destination.mjs` (`makeDestination`, ~line 26-36)
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (`mapErrorToCode`, ~line 19-29)
- Test: `plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts` (extend with a git source, in-process + stubbed transport)

**Interfaces:**
- Consumes: `createHttpBundleSource` (Task 2); `searchCommand(args, { transport })` (existing export).
- Produces: `resolveDestination` builds `gitlab`/`github`/`http` sources; `mapErrorToCode` returns `bundle-invalid` for `err.code === 'bundle-invalid'`.

- [ ] **Step 1: Write the failing test**

```ts
// append to cli-search-sources.test.ts (in-process, stubbed transport)
import { searchCommand } from '../pwiki.mjs';
// ... reuse the exitSpy/stdoutSpy harness from the failing-source describe block ...

it('unions a gitlab bundle source with the fs primary', async () => {
  // .pwiki.json for `dir` has: sources:['git'], destinations.git = {kind:'gitlab', project:'g/p'}
  const BUNDLE = { schema: 1, generated: '2026-07-01', wikiRoot: 'docs/wiki', pages: [
    { type: 'concept', id: 'shared', path: 'docs/wiki/pages/concept/shared.md',
      frontmatter: { id: 'shared', type: 'concept', title: 'Shared Kafka', tags: [] }, body: '# Shared Kafka' } ] };
  const b64 = Buffer.from(JSON.stringify(BUNDLE), 'utf-8').toString('base64');
  const transport = async () => ({ status: 200, headers: {}, body: { content: b64, encoding: 'base64' } });
  try { await searchCommand({ _: ['kafka'], format: 'json' }, { transport }); }
  catch (e: any) { expect(e.message).toBe('exit:0'); }
  const json = JSON.parse(out);
  expect(json.results.some((x: any) => x.source === 'git')).toBe(true);
  expect(json.warnings).toEqual([]);
});
```

Also add a unit assertion for `mapErrorToCode`:

```ts
// cli-error-codes.test.ts (or config.test.ts)
import { mapErrorToCode } from '../pwiki.mjs';
it('maps err.code=bundle-invalid', () => {
  expect(mapErrorToCode({ code: 'bundle-invalid' })).toBe('bundle-invalid');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts`
Expected: FAIL — `makeDestination` throws `unknown destination kind: gitlab`; `mapErrorToCode` returns `internal` for `bundle-invalid`.

- [ ] **Step 3: Implement the wiring**

In `destination.mjs`, add before the final `throw`:

```js
import { createHttpBundleSource } from './destinations/http-bundle.mjs';
// ...inside makeDestination, after the confluence branch:
if (block.kind === 'gitlab' || block.kind === 'github' || block.kind === 'http') {
  return createHttpBundleSource({ kind: block.kind, destinationConfig: block, transport: env.transport, env: process.env });
}
```

In `pwiki.mjs`, add one line at the top of `mapErrorToCode`:

```js
export function mapErrorToCode(err) {
  if (err?.code === 'bundle-invalid') return 'bundle-invalid';
  if (err?.message && /invalid \.pwiki\.json/.test(err.message)) return 'config-invalid';
  // ...unchanged...
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destination.mjs plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts
git commit -m "feat(p-wiki): resolve http-bundle sources + map bundle-invalid error"
```

---

### Task 4: Bundle generation + `reindex` command

**Files:**
- Create: `plugins/p-wiki/tools/lib/bundle.mjs`
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (add `reindex` command dispatch; emit `index.json` where `index.md` is regenerated)
- Test: `plugins/p-wiki/tools/__tests__/bundle.test.ts`

**Interfaces:**
- Consumes: an fs destination's `listPages({ in: 'pages' })` + `readPage(path)`; `today()` from `./paths.mjs`.
- Produces: `buildBundle(dest) → { schema:1, generated, wikiRoot:'docs/wiki', pages:[{type,id,path,frontmatter,body}] }`; a `pwiki reindex` CLI command that writes `docs/wiki/index.json`.

- [ ] **Step 1: Write the failing test**

```ts
// bundle.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../lib/bundle.mjs';
import { createFsDestination } from '../lib/destinations/fs.mjs';
import { createHttpBundleSource } from '../lib/destinations/http-bundle.mjs';

const PAGE = (id: string) => `---\nid: ${id}\ntype: concept\ntitle: ${id}\ntags: []\n---\n\n# ${id}\n\nbody of ${id}.\n`;

describe('buildBundle + round-trip', () => {
  it('captures pages/ (not raw/) and round-trips through the http reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pwiki-bundle-'));
    mkdirSync(join(root, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    mkdirSync(join(root, 'docs', 'wiki', 'raw', 'articles'), { recursive: true });
    writeFileSync(join(root, 'docs', 'wiki', 'pages', 'concept', 'a.md'), PAGE('a'));
    writeFileSync(join(root, 'docs', 'wiki', 'raw', 'articles', 'skip.md'), PAGE('skip'));

    const fs = createFsDestination({ root });
    const bundle = buildBundle(fs);
    expect(bundle.schema).toBe(1);
    expect(bundle.pages.map(p => p.id).sort()).toEqual(['a']); // raw/ excluded

    const src = createHttpBundleSource({ kind: 'http', destinationConfig: { kind: 'http', url: 'x' },
      transport: async () => ({ status: 200, headers: {}, body: bundle }), env: {} });
    const r = await src.search('body', {});
    expect(r.results[0].path).toBe('docs/wiki/pages/concept/a.md');
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/bundle.test.ts`
Expected: FAIL — `../lib/bundle.mjs` does not exist.

- [ ] **Step 3: Implement bundle.mjs + reindex**

```js
// plugins/p-wiki/tools/lib/bundle.mjs
import { today } from './paths.mjs';

export function buildBundle(dest) {
  const listed = dest.listPages({ in: 'pages' });
  const pages = [];
  for (const { path, frontmatter } of listed) {
    const { body } = dest.readPage(path);
    pages.push({ type: frontmatter.type, id: frontmatter.id, path, frontmatter, body });
  }
  pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // stable output
  return { schema: 1, generated: today(), wikiRoot: 'docs/wiki', pages };
}
```

In `pwiki.mjs`, add a `reindex` command (near the other command dispatches). It regenerates the human index and writes the bundle:

```js
import { buildBundle } from './lib/bundle.mjs';
// ...
if (command === 'reindex') {
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts?.transport ?? makeRealTransport() });
  if (!res) die('not inside a p-wiki repo', 1);
  const idx = res.primary.regenerateIndex();                       // writes index.md
  const root = findWikiRoot(process.cwd());
  const bundle = buildBundle(res.primary);
  writeFileSync(join(root, 'docs', 'wiki', 'index.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  emitJson({ index: idx, bundle: { pages: bundle.pages.length, path: 'docs/wiki/index.json' } });
}
```

(Import `findWikiRoot`/`writeFileSync`/`join` if not already imported. Wherever the existing `index` command calls `regenerateIndex`, also write `index.json` via the same two lines so normal editing keeps it fresh.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/bundle.mjs plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/bundle.test.ts
git commit -m "feat(p-wiki): reindex command emits docs/wiki/index.json bundle"
```

---

### Task 5: Documentation

**Files:**
- Modify: `plugins/p-wiki/README.md` (Multi-destination / sources section)
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md` (CLI section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the README**

Add to the sources documentation: the `gitlab`/`github`/`http` source kinds; the env tokens (`PWIKI_GITLAB_TOKEN` / `PWIKI_GITHUB_TOKEN` / the `http` block's `authTokenEnv`); `baseUrl`/`apiBaseUrl`/`ref`/`indexPath` fields; that these kinds are source-only; that publishing is `pwiki reindex` (or a pre-push hook) + `git push` — no `sync`, no Confluence needed; and the committed-bundle-churn note with the gitignore-+-Pages alternative. Include a "shared wiki over git" recipe (shared repo publishes `index.json`; service repos add a source).

- [ ] **Step 2: Update the CLAUDE.md template**

Add `pwiki reindex`, the new source kinds, and that `get --source=<name>` / `search` work against them, to `wiki-claude-md.template.md`'s CLI section.

- [ ] **Step 3: Verify docs coverage**

Run: `npx vitest run` (the marketplace/readme-coverage suite must stay green)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/README.md plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md
git commit -m "docs(p-wiki): document gitlab/github/http sources + reindex"
```

---

## Version bump (release-time, not a task)

Bump `plugins/p-wiki/.claude-plugin/plugin.json` `version` 4.11.0 → 4.12.0 and add a `RELEASE-NOTES.md` entry as part of the release commit (per the repo's release rules — done via `/release`, not inline here).

## Self-review

- **Spec coverage:** config (§4.1) → Task 1; resolution (§5) + mapErrorToCode (§5) → Task 3; reader (§6) + error handling (§7) → Task 2; bundle + reindex (§2, §3) → Task 4; docs (§11) → Task 5; version (§12) → release step. `search`/`get` union (§4-§6) needs no code change (verified) — covered by the Task 3 union test.
- **Type consistency:** `createHttpBundleSource({kind,destinationConfig,transport,env})` defined in Task 2, consumed identically in Tasks 3 (destination.mjs) and 4 (tests). `buildBundle(dest)` defined in Task 4, consumed in its own test. Bundle shape `{schema,generated,wikiRoot,pages:[{type,id,path,frontmatter,body}]}` identical in Tasks 2 and 4.
- **No placeholders:** every code step carries real code; no TBD/TODO.
