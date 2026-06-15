# `pwiki get` — Universal Page-Content Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pwiki get <path>` CLI command that surfaces the existing `readPage()` for both filesystem and Confluence backends, and switch the `query` and `reconcile` skills' page-read steps from the built-in `Read` tool to `pwiki get`.

**Architecture:** `get` is an exported async function `getPage(args, _opts)` in `tools/pwiki.mjs` (mirroring `initConfluence`), so Confluence behavior is testable in-process with a fake transport. It resolves the primary destination, calls `await readPage(path)` (FS sync / Confluence async — one `await` covers both), and prints either reconstructed markdown (`serializeFrontmatter`) or JSON. Not-found and malformed-path errors are handled locally in the handler (the global `mapErrorToCode` only maps HTTP `.status`, so a bare throw would mis-report as `internal`/exit 3).

**Tech Stack:** Node ESM (`.mjs`), Vitest (tests are `.ts` under `tools/__tests__/`), no new dependencies.

**Spec:** `plugins/p-wiki/docs/superpowers/specs/2026-06-15-pwiki-universal-page-read-design.md`

---

## File Structure

- `plugins/p-wiki/tools/pwiki.mjs` — MODIFY: import `serializeFrontmatter`; add exported `getPage`; add `'get'` to `KNOWN`; add dispatch block.
- `plugins/p-wiki/tools/__tests__/cli-get.test.ts` — CREATE: FS subprocess tests (text, json, not-found, unknown-format).
- `plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts` — CREATE: in-process `getPage` test with fake Confluence transport.
- `plugins/p-wiki/skills/query/SKILL.md` — MODIFY: Step 3 page read.
- `plugins/p-wiki/skills/reconcile/SKILL.md` — MODIFY: Step 4a page read.
- `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md` — MODIFY: CLI tool section.
- `plugins/p-wiki/.claude-plugin/plugin.json` — MODIFY: version → 4.8.0.

All test commands run from the **repo root** (`C:\projects\perky.team\claude-plugin`), where `vitest.config.ts` lives.

---

## Task 1: `pwiki get` command for the filesystem backend

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (import line 6; KNOWN line 216; new function before line 204 `const isMain`; dispatch after the `search` block)
- Test: `plugins/p-wiki/tools/__tests__/cli-get.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `plugins/p-wiki/tools/__tests__/cli-get.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

const PAGE =
  `---\nid: kafka\ntype: concept\ntitle: Kafka\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [streaming]\nsources: []\n---\n\n# Kafka\n\nKafka handles partitioning across consumer groups.\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-get-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'), PAGE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki get (FS)', () => {
  it('prints reconstructed markdown (frontmatter fence + body) by default', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/kafka.md']);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('---\n')).toBe(true);
    expect(r.stdout).toContain('id: kafka');
    expect(r.stdout).toContain('# Kafka');
    expect(r.stdout).toContain('Kafka handles partitioning across consumer groups.');
  });

  it('--format=json returns { path, frontmatter, body }', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/kafka.md', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.path).toBe('docs/wiki/pages/concept/kafka.md');
    expect(json.frontmatter.id).toBe('kafka');
    expect(json.frontmatter.title).toBe('Kafka');
    expect(json.frontmatter.tags).toEqual(['streaming']);
    expect(json.body).toContain('# Kafka');
  });

  it('missing page → exit 1 with error.code page-not-found', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/ghost.md', '--format=json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('page-not-found');
  });

  it('unknown --format is treated as text', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/kafka.md', '--format=xml']);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('---\n')).toBe(true);
    expect(r.stdout).toContain('# Kafka');
  });

  it('no path argument → exit 1', () => {
    const r = runCli(['get']);
    expect(r.status).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-get.test.ts`
Expected: FAIL — all cases fail because `get` is rejected by `KNOWN` with "unknown command: get" (exit 1, no JSON), so e.g. the json/text assertions don't match.

- [ ] **Step 3: Import `serializeFrontmatter`**

In `plugins/p-wiki/tools/pwiki.mjs`, change line 6 from:

```js
import { parseFrontmatter } from './lib/fm.mjs';
```
to:
```js
import { parseFrontmatter, serializeFrontmatter } from './lib/fm.mjs';
```

- [ ] **Step 4: Add the exported `getPage` function**

In `plugins/p-wiki/tools/pwiki.mjs`, immediately **before** the line `const isMain = ...` (currently line 204), add:

```js
export async function getPage(args) {
  const path = args._[0];
  if (!path) die('get: <path> required', 1);
  const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
  if (!res) die('not inside a p-wiki repo', 1);
  const dest = res.primary;

  let page;
  try {
    // FS readPage is synchronous, Confluence is async; a single await covers both.
    page = await dest.readPage(path);
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/^page not found:/.test(msg)) emitJson({ error: { code: 'page-not-found', message: msg } }, 1);
    if (/not a confluence:\/\//.test(msg)) emitJson({ error: { code: 'bad-path', message: msg } }, 1);
    throw e; // auth/rate-limit/network errors carry .status/.code → top-level mapErrorToCode
  }

  if ((args.format ?? 'text') === 'json') {
    emitJson({ path: page.path, frontmatter: page.frontmatter, body: page.body }, 0);
  }
  process.stdout.write(serializeFrontmatter(page.frontmatter, page.body));
  process.exit(0);
}
```

- [ ] **Step 5: Register `get` in `KNOWN`**

In `plugins/p-wiki/tools/pwiki.mjs`, change line 216 from:

```js
const KNOWN = ['new', 'set', 'promote', 'search', 'lint', 'backlinks', 'index', 'init', 'sync'];
```
to:
```js
const KNOWN = ['new', 'set', 'promote', 'search', 'lint', 'backlinks', 'index', 'init', 'sync', 'get'];
```

- [ ] **Step 6: Add the dispatch block**

In `plugins/p-wiki/tools/pwiki.mjs`, find the end of the `if (command === 'search') { ... }` block (it ends with `emitJson({ query, total: r.total, results: r.results }, 0);` then `}`). Immediately after that closing `}`, add:

```js
  if (command === 'get') {
    await getPage(args);
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-get.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 8: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-get.test.ts
git commit -m "feat(p-wiki): add pwiki get command for reading a page (FS)"
```

---

## Task 2: Confluence support via a transport seam

The FS path works without a transport. Confluence needs the test to inject a fake transport, so `getPage` must accept `_opts.transport` like `initConfluence` does.

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (`getPage` signature + transport line)
- Test: `plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts`

- [ ] **Step 1: Write the failing Confluence test file**

Create `plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { getPage } from '../pwiki.mjs';

let dir: string;
let cwd: string;
let exitSpy: any;
let stdoutSpy: any;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-get-conf-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
  writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
    primary: 'confluence',
    mirrors: [],
    destinations: {
      confluence: {
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

describe('getPage (Confluence, fake transport)', () => {
  it('reads body (ADF→markdown) and frontmatter (from properties)', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }] };
    const fake = createFakeConfluence({
      spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
      initialPages: [
        { id: '200', title: 'Foo', parentId: '101', body: adf, properties: [
          { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
          { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
          { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
          { key: 'pwiki-tags', value: '["streaming"]' }, { key: 'pwiki-sources', value: '[]' },
        ] },
      ],
    });
    try {
      await getPage({ _: ['confluence://concept/foo'], format: 'json' }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const json = JSON.parse(out);
    expect(json.path).toBe('confluence://concept/foo');
    expect(json.frontmatter.title).toBe('Foo');
    expect(json.frontmatter.tags).toEqual(['streaming']);
    expect(json.body).toBe('# Foo');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts`
Expected: FAIL — `getPage` currently ignores `_opts`, so it builds a real transport; the fake pages are never reached and the read throws / the JSON assertions fail.

- [ ] **Step 3: Thread `_opts.transport` into `getPage`**

In `plugins/p-wiki/tools/pwiki.mjs`, change the `getPage` signature and the `resolveDestination` line:

```js
export async function getPage(args, _opts = {}) {
```
and
```js
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts.transport ?? makeRealTransport() });
```

(The dispatch block `await getPage(args)` stays as-is — production omits `_opts`, so it falls back to `makeRealTransport()`.)

- [ ] **Step 4: Run the Confluence test to verify it passes**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts`
Expected: PASS.

- [ ] **Step 5: Run both `get` test files to confirm no regression**

Run: `npx vitest run plugins/p-wiki/tools/__tests__/cli-get.test.ts plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts
git commit -m "feat(p-wiki): support Confluence backend in pwiki get via transport seam"
```

---

## Task 3: Switch the `query` skill's page read to `pwiki get`

**Files:**
- Modify: `plugins/p-wiki/skills/query/SKILL.md` (Step 3, currently lines 30-32)

- [ ] **Step 1: Replace Step 3**

In `plugins/p-wiki/skills/query/SKILL.md`, replace:

```markdown
## Step 3 — Read top results

For each `path` in `results`, use Read to load the full page body. Cite only files you actually read.
```
with:
```markdown
## Step 3 — Read top results

For each `path` in `results`, load the full page content with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" get "<path>"
```

This works for both FS and Confluence wikis (do **not** use the `Read` tool for wiki pages — it only opens local files). Cite only pages you actually read.
```

- [ ] **Step 2: Verify the skill still declares the tools it needs**

Confirm `plugins/p-wiki/skills/query/SKILL.md` line 6 `allowed-tools` already contains `Bash(node:*)` (it does) — no change needed. `Read` stays in `allowed-tools` because Step 6/8 still edit the query-output file.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/skills/query/SKILL.md
git commit -m "feat(p-wiki): query reads pages via pwiki get (backend-agnostic)"
```

---

## Task 4: Switch the `reconcile` skill's page read to `pwiki get`

**Files:**
- Modify: `plugins/p-wiki/skills/reconcile/SKILL.md` (Step 4a, currently lines 50-52)

- [ ] **Step 1: Replace Step 4a**

In `plugins/p-wiki/skills/reconcile/SKILL.md`, replace:

```markdown
### 4a. Read

Read the page (frontmatter + body, including any callout).
```
with:
```markdown
### 4a. Read

Load the page (frontmatter + body, including any callout) with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" get <path> --format=json
```

Parse the JSON: `frontmatter` and `body` are returned separately. Detect the conflict callout in `body`. This works for both FS and Confluence wikis — do **not** use the `Read` tool for the wiki page (the source files in 4b are still read with `Read`).
```

- [ ] **Step 2: Commit**

```bash
git add plugins/p-wiki/skills/reconcile/SKILL.md
git commit -m "feat(p-wiki): reconcile reads pages via pwiki get (backend-agnostic)"
```

---

## Task 5: Update the wiki CLAUDE.md template docs

**Files:**
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md` (CLI tool section, ~lines 157-167)

- [ ] **Step 1: Add `get` to the CLI operations list**

In `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md`, in the "## CLI tool" bullet list (after the "Ranked search" bullet, currently line 162), add a new bullet:

```markdown
- **Reading a page** — `pwiki get <path> [--format=json]` (returns the page's frontmatter + body for FS *or* Confluence; use this instead of the `Read` tool for any wiki page, since `Read` only opens local files).
```

- [ ] **Step 2: Adjust the Read/Write/Edit note**

In the same file, replace the paragraph (currently line 167):

```markdown
Generic Read/Write/Edit remain for **body editing** in skills (adding facts to sections, synthesizing answers, conflict callouts). The CLI touches body text only in two specific deterministic operations: rendering the template body of a new page (`pwiki new`) and inserting backlink hyperlinks (`pwiki backlinks`).
```
with:
```markdown
Reading a wiki **page** goes through `pwiki get` (backend-agnostic). Generic Read/Write/Edit remain for reading **non-page** files (sources in `raw/`, templates) and for **body editing** of FS pages in skills (adding facts to sections, synthesizing answers, conflict callouts). The CLI touches body text only in deterministic operations: rendering the template body of a new page (`pwiki new`), inserting backlink hyperlinks (`pwiki backlinks`), and returning content for reads (`pwiki get`).
```

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md
git commit -m "docs(p-wiki): document pwiki get in the wiki CLAUDE.md template"
```

---

## Task 6: Bump the plugin version

**Files:**
- Modify: `plugins/p-wiki/.claude-plugin/plugin.json` (`version` field)

- [ ] **Step 1: Bump version to 4.8.0**

In `plugins/p-wiki/.claude-plugin/plugin.json`, change `"version": "4.7.1"` to `"version": "4.8.0"`.

- [ ] **Step 2: Run the FULL p-wiki test suite to confirm nothing regressed**

Run: `npx vitest run plugins/p-wiki`
Expected: PASS (entire p-wiki suite green, including the two new `cli-get*` files).

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/.claude-plugin/plugin.json
git commit -m "chore(p-wiki): bump version to 4.8.0 (pwiki get)"
```

---

## Notes for the implementer

- **Do not extend `mapErrorToCode`** to match the `page not found` message — it would change exit codes for every other command. The not-found mapping is intentionally local to `getPage` (Task 1, Step 4).
- **`compile` is deliberately untouched.** Its body-editing path is FS-Edit-based (the write path), which this feature does not address. Do not add a `pwiki get` call to compile.
- **Monorepo release tag** (e.g. `v4.16.0`) and the README/`marketplace.json` edits already committed on this branch are handled at push/release time per the repo's release procedure — not in this plan.
- If any step's "Expected" output does not match, stop and use `superpowers:systematic-debugging` rather than guessing.
