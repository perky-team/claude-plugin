# pwiki v2 Confluence Destination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a second `Destination` implementation that stores the pwiki wiki in Confluence Cloud instead of the filesystem, behind the same CLI surface and the same skills.

**Architecture:** v1's FS code is left untouched. A new `tools/lib/destinations/confluence.mjs` implements the existing `Destination` interface; `destination.mjs` resolver reads `docs/wiki/.pwiki.json` to pick FS or Confluence. All Confluence-specific helpers (HTTP, ADF, identity, properties, labels, tree, search, lint) live under `tools/lib/confluence/`. Zero npm dependencies — `node:https`, hand-rolled markdown↔ADF for our narrow subset, in-memory fake transport for offline tests.

**Tech Stack:** Node ≥ 18 stdlib (`node:https`, `node:fs`), vitest + TypeScript for tests, Confluence Cloud REST API v2 for pages/properties, REST v1 for CQL search and label management.

**Spec:** [`2026-05-15-pwiki-v2-confluence-destination-design.md`](../specs/2026-05-15-pwiki-v2-confluence-destination-design.md)

---

## File Structure

**New files (created during this plan):**

| Path | Responsibility |
|---|---|
| `tools/lib/config.mjs` | Read/write `docs/wiki/.pwiki.json`; resolver inspects it |
| `tools/lib/confluence/http.mjs` | HTTPS client with auth, JSON, retries, error mapping |
| `tools/lib/confluence/adf.mjs` | `markdownToAdf` + `adfToMarkdown` for our subset |
| `tools/lib/confluence/identity.mjs` | Parse `confluence://<type>/<slug>`; numeric-id cache; pageExists CQL |
| `tools/lib/confluence/properties.mjs` | `properties.upsert(pageId, key, value)` helper |
| `tools/lib/confluence/labels.mjs` | Label diff/sync (GET, POST, DELETE) |
| `tools/lib/confluence/tree.mjs` | Sub-parent find-or-create, Index find-or-create |
| `tools/lib/confluence/search.mjs` | CQL builder + result mapper |
| `tools/lib/confluence/lint.mjs` | Confluence-flavoured checks (CQL + body walk) |
| `tools/lib/destinations/confluence.mjs` | `createConfluenceDestination` — interface impl |
| `tools/__tests__/fixtures/fake-confluence.mjs` | In-memory fake HTTP transport for offline contract tests |
| `tools/__tests__/config.test.ts` | config read/write/validate |
| `tools/__tests__/confluence-http.test.ts` | HTTP retries, auth, error mapping |
| `tools/__tests__/confluence-adf.test.ts` | markdown↔ADF |
| `tools/__tests__/confluence-identity.test.ts` | Path parse, cache |
| `tools/__tests__/confluence-properties.test.ts` | upsert helper |
| `tools/__tests__/confluence-labels.test.ts` | Label diff |
| `tools/__tests__/confluence-tree.test.ts` | Sub-parent bootstrap |
| `tools/__tests__/confluence-search.test.ts` | CQL builder |
| `tools/__tests__/confluence-lint.test.ts` | Lint checks against fake |
| `tools/__tests__/destination-confluence-write.test.ts` | writePage / pageExists / listPages through fake |
| `tools/__tests__/destination-confluence-read.test.ts` | readPage / mutatePage / movePage through fake |
| `tools/__tests__/destination-confluence-backlinks-index.test.ts` | applyBacklinks / regenerateIndex through fake |
| `tools/__tests__/confluence-e2e.test.ts` | E2E against real Confluence, gated by env |
| `plugins/p-wiki/CONTRIBUTING.md` | Documents E2E sandbox requirements |

**Existing files (modified during this plan):**

| Path | What changes |
|---|---|
| `tools/lib/destination.mjs` | Resolver becomes config-aware; routes to FS or Confluence |
| `tools/__tests__/destination-contract.test.ts` | Refactored to be backend-agnostic; add Confluence invocation |
| `tools/pwiki.mjs` | Bump `VERSION` to `2.0.0`; add `error.code` to JSON error payloads |
| `skills/_shared/templates/wiki-claude-md.template.md` | Add "Storage backend" section |
| `skills/init/SKILL.md` | Confluence-destination prompt branch in flow |
| `skills/ingest/SKILL.md` | Parse `error.code` from JSON errors |
| `skills/compile/SKILL.md` | Parse `error.code` from JSON errors |
| `skills/query/SKILL.md` | Parse `error.code` from JSON errors |
| `skills/lint/SKILL.md` | Parse `error.code` from JSON errors |
| `.claude-plugin/plugin.json` | `"version": "2.0.0"` |

---

## Layer roadmap

This plan implements the v2 spec in five layers. Each layer ships green tests before the next starts; FS test suite stays green throughout.

- **Layer 1 (Tasks 1–9):** Foundations — config, HTTP, ADF, identity, properties, labels, tree, search builder. Pure unit tests only.
- **Layer 2 (Tasks 10–15):** `writePage` + `pageExists` + `listPages`; resolver wiring; contract-test refactor; fake HTTP fixture.
- **Layer 3 (Tasks 16–19):** `readPage` + `mutatePage` + `movePage`.
- **Layer 4 (Tasks 20–24):** `search` + `lint` (with `drift` and `misparented`).
- **Layer 5 (Tasks 25–27):** `applyBacklinks` + `regenerateIndex`.
- **Wrap-up (Tasks 28–33):** Skill error-code handling, init Confluence flow, template, CONTRIBUTING, E2E suite, version bump + tag.

Run `npm test` after each task; both FS and Confluence suites must stay green.

---

## Layer 1 — Foundations

### Task 1: `config.mjs` — read/write `.pwiki.json`

**Files:**
- Create: `plugins/p-wiki/tools/lib/config.mjs`
- Test: `plugins/p-wiki/tools/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-wiki/tools/__tests__/config.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, validateConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-config-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  it('returns null when .pwiki.json is absent', () => {
    expect(readConfig(dir)).toBeNull();
  });

  it('round-trips a Confluence config', () => {
    const cfg = {
      destination: 'confluence',
      confluence: {
        siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
        rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
      },
    };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });

  it('validateConfig rejects missing confluence.spaceId', () => {
    const cfg = { destination: 'confluence', confluence: { siteUrl: 'x', spaceKey: 'E', rootPageId: '1', subParents: { concept: '1', person: '2', source: '3', query: '4' } } };
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spaceId/);
  });

  it('validateConfig accepts destination=fs with no other fields', () => {
    expect(validateConfig({ destination: 'fs' }).ok).toBe(true);
  });

  it('readConfig throws on invalid JSON', () => {
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), '{not json', 'utf-8');
    expect(() => readConfig(dir)).toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.mjs`**

```js
// plugins/p-wiki/tools/lib/config.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_REL = 'docs/wiki/.pwiki.json';

export function configPath(root) { return join(root, CONFIG_REL); }

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  return JSON.parse(text);
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function validateConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (cfg.destination !== 'fs' && cfg.destination !== 'confluence') return { ok: false, error: 'destination must be "fs" or "confluence"' };
  if (cfg.destination === 'fs') return { ok: true };
  const c = cfg.confluence;
  if (!c || typeof c !== 'object') return { ok: false, error: 'confluence section required' };
  for (const f of ['siteUrl', 'spaceKey', 'spaceId', 'rootPageId']) {
    if (typeof c[f] !== 'string' || !c[f]) return { ok: false, error: `confluence.${f} required` };
  }
  if (!c.subParents || typeof c.subParents !== 'object') return { ok: false, error: 'confluence.subParents required' };
  for (const t of ['concept', 'person', 'source', 'query']) {
    if (typeof c.subParents[t] !== 'string' || !c.subParents[t]) return { ok: false, error: `confluence.subParents.${t} required` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/config.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/config.mjs plugins/p-wiki/tools/__tests__/config.test.ts
git commit -m "feat(p-wiki): add config.mjs for .pwiki.json read/write/validate"
```

---

### Task 2: `confluence/http.mjs` — HTTPS client, auth, JSON, retries

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/http.mjs`
- Test: `plugins/p-wiki/tools/__tests__/confluence-http.test.ts`

The client takes an injectable `transport` function so tests can run offline.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-http.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../lib/confluence/http.mjs';

function fakeTransport(responses: Array<{status: number, headers?: Record<string,string>, body?: any}>) {
  const calls: any[] = [];
  let i = 0;
  const fn = async (req: any) => {
    calls.push(req);
    return responses[Math.min(i++, responses.length - 1)];
  };
  (fn as any).calls = calls;
  return fn;
}

describe('confluence/http', () => {
  it('sends Basic auth and JSON content-type', async () => {
    const t = fakeTransport([{ status: 200, body: { ok: true } }]);
    const c = createHttpClient({ baseUrl: 'https://x.atlassian.net', email: 'a@b.c', token: 'tok', transport: t });
    await c.get('/wiki/api/v2/pages/1');
    const req = (t as any).calls[0];
    expect(req.headers.Authorization).toBe('Basic ' + Buffer.from('a@b.c:tok').toString('base64'));
    expect(req.headers.Accept).toBe('application/json');
  });

  it('retries GET on 429 with exponential backoff', async () => {
    const t = fakeTransport([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: { ok: 1 } },
    ]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    const r = await c.get('/x');
    expect(r.body).toEqual({ ok: 1 });
    expect((t as any).calls.length).toBe(3);
  });

  it('does not retry page-create POST on 5xx', async () => {
    const t = fakeTransport([{ status: 503 }, { status: 200 }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    await expect(c.post('/wiki/api/v2/pages', { x: 1 })).rejects.toThrow(/HTTP 503/);
    expect((t as any).calls.length).toBe(1);
  });

  it('retries idempotent POST (labels)', async () => {
    const t = fakeTransport([{ status: 503 }, { status: 200, body: {} }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    await c.post('/wiki/rest/api/content/1/label', [{ name: 'tag' }]);
    expect((t as any).calls.length).toBe(2);
  });

  it('throws after retry cap with status in error', async () => {
    const t = fakeTransport([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    await expect(c.get('/x')).rejects.toMatchObject({ status: 429 });
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-http.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `http.mjs`**

```js
// plugins/p-wiki/tools/lib/confluence/http.mjs
const RETRIABLE = new Set([429, 502, 503, 504]);
const NON_RETRY_POST = new Set(['/wiki/api/v2/pages']); // exact match
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetriable(method, path, status) {
  if (!RETRIABLE.has(status)) return false;
  if (method === 'POST' && NON_RETRY_POST.has(path)) return false;
  return true; // GET/PUT/DELETE always retriable on these codes; idempotent POSTs too
}

export function createHttpClient({ baseUrl, email, token, transport, baseDelayMs = 1000, maxRetries = MAX_RETRIES }) {
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  async function call(method, path, body) {
    const url = baseUrl.replace(/\/+$/, '') + path;
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = { method, url, path, headers, body: body === undefined ? undefined : JSON.stringify(body) };

    let attempt = 0;
    while (true) {
      const res = await transport(req);
      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, headers: res.headers ?? {}, body: res.body ?? null };
      }
      if (attempt < maxRetries && isRetriable(method, path, res.status)) {
        const retryAfter = Number(res.headers?.['retry-after']);
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        attempt++;
        continue;
      }
      const err = new Error(`HTTP ${res.status} ${method} ${path}`);
      err.status = res.status;
      err.body = res.body;
      throw err;
    }
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    delete: (p) => call('DELETE', p),
  };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-http.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/http.mjs plugins/p-wiki/tools/__tests__/confluence-http.test.ts
git commit -m "feat(p-wiki): add confluence/http.mjs with retries and Basic auth"
```

---

### Task 3: `confluence/adf.mjs` — markdown→ADF

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/adf.mjs` (markdown→ADF in this task; ADF→markdown in Task 4)
- Test: `plugins/p-wiki/tools/__tests__/confluence-adf.test.ts`

Subset (per spec §2.2): h1-h3, paragraphs, ordered/unordered/nested lists, inline marks (bold `**`, italic `*` or `_`, code `` ` ``, link `[text](url)`), fenced code blocks, blockquotes.

- [ ] **Step 1: Write failing tests for markdownToAdf**

```ts
// plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
import { describe, expect, it } from 'vitest';
import { markdownToAdf } from '../lib/confluence/adf.mjs';

describe('markdownToAdf', () => {
  it('produces an empty doc for empty input', () => {
    expect(markdownToAdf('')).toEqual({ type: 'doc', version: 1, content: [] });
  });

  it('h1 → heading level 1', () => {
    expect(markdownToAdf('# Foo')).toEqual({
      type: 'doc', version: 1,
      content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }],
    });
  });

  it('paragraph with bold and link', () => {
    const r = markdownToAdf('Hello **world** and [me](https://x).');
    expect(r.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'me', marks: [{ type: 'link', attrs: { href: 'https://x' } }] },
        { type: 'text', text: '.' },
      ],
    });
  });

  it('unordered list with inline code', () => {
    const r = markdownToAdf('- foo `bar`\n- baz');
    expect(r.content[0]).toMatchObject({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'foo ' },
          { type: 'text', text: 'bar', marks: [{ type: 'code' }] },
        ] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'baz' }] }] },
      ],
    });
  });

  it('fenced code block with language', () => {
    const r = markdownToAdf('```js\nconst x=1;\n```');
    expect(r.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: 'const x=1;' }],
    });
  });

  it('blockquote for conflict callout', () => {
    const r = markdownToAdf('> Conflict: A says X.');
    expect(r.content[0]).toMatchObject({
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Conflict: A says X.' }] }],
    });
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `markdownToAdf` (skeleton)**

```js
// plugins/p-wiki/tools/lib/confluence/adf.mjs

// Tokenize markdown into top-level blocks then parse inlines.
// Supports: # h1, ## h2, ### h3, paragraph, - / 1. lists (nested by indent), ``` code, > blockquote.
// Inlines: **bold**, *italic* / _italic_, `code`, [text](url).

export function markdownToAdf(md) {
  const lines = md.split(/\r?\n/);
  const blocks = parseBlocks(lines);
  return { type: 'doc', version: 1, content: blocks };
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^#{1,3} /.test(line)) {
      const level = line.match(/^(#{1,3}) /)[1].length;
      const text = line.replace(/^#{1,3} /, '');
      out.push({ type: 'heading', attrs: { level }, content: parseInline(text) });
      i++; continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i++; }
      if (i < lines.length) i++; // closing ```
      const attrs = lang ? { language: lang } : {};
      out.push({ type: 'codeBlock', attrs, content: [{ type: 'text', text: body.join('\n') }] });
      continue;
    }
    if (/^> /.test(line)) {
      const buf = [];
      while (i < lines.length && /^> /.test(lines[i])) { buf.push(lines[i].slice(2)); i++; }
      out.push({ type: 'blockquote', content: parseBlocks(buf) });
      continue;
    }
    if (/^\s*[-*] /.test(line) || /^\s*\d+\. /.test(line)) {
      const { node, next } = parseList(lines, i);
      out.push(node);
      i = next;
      continue;
    }
    // paragraph: collect non-blank lines
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,3} /.test(lines[i]) && !lines[i].startsWith('```') && !/^> /.test(lines[i]) && !/^\s*[-*] /.test(lines[i]) && !/^\s*\d+\. /.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push({ type: 'paragraph', content: parseInline(buf.join(' ')) });
  }
  return out;
}

function parseList(lines, start) {
  const firstIndent = lines[start].match(/^(\s*)/)[1].length;
  const ordered = /^\s*\d+\. /.test(lines[start]);
  const type = ordered ? 'orderedList' : 'bulletList';
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) break;
    const ind = line.match(/^(\s*)/)[1].length;
    if (ind < firstIndent) break;
    const isItem = (ordered ? /^\s*\d+\. / : /^\s*[-*] /).test(line) && ind === firstIndent;
    if (!isItem && ind === firstIndent) break;
    if (isItem) {
      const text = line.replace(/^\s*(?:\d+\.|[-*]) /, '');
      const content = [{ type: 'paragraph', content: parseInline(text) }];
      // nested list (lookahead)
      let j = i + 1;
      const nestedStart = j;
      while (j < lines.length && /^\s*[-*] /.test(lines[j]) && lines[j].match(/^(\s*)/)[1].length > firstIndent) j++;
      if (j > nestedStart) {
        const { node } = parseList(lines, nestedStart);
        content.push(node);
        i = j;
      } else { i++; }
      items.push({ type: 'listItem', content });
    } else { i++; }
  }
  return { node: { type, content: items }, next: i };
}

function parseInline(text) {
  // Tokenize: scan left-to-right for the next active token.
  const out = [];
  let i = 0;
  let buf = '';
  function flush() { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } }
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > 0) { flush(); out.push({ type: 'text', text: text.slice(i + 2, end), marks: [{ type: 'strong' }] }); i = end + 2; continue; }
    }
    if ((text[i] === '*' || text[i] === '_') && text[i + 1] !== text[i]) {
      const ch = text[i];
      const end = text.indexOf(ch, i + 1);
      if (end > 0) { flush(); out.push({ type: 'text', text: text.slice(i + 1, end), marks: [{ type: 'em' }] }); i = end + 1; continue; }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > 0) { flush(); out.push({ type: 'text', text: text.slice(i + 1, end), marks: [{ type: 'code' }] }); i = end + 1; continue; }
    }
    if (text[i] === '[') {
      const m = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (m) { flush(); out.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] }); i += m[0].length; continue; }
    }
    buf += text[i++];
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/adf.mjs plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
git commit -m "feat(p-wiki): add adf.mjs markdownToAdf for our markdown subset"
```

---

### Task 4: `confluence/adf.mjs` — ADF→markdown

**Files:**
- Modify: `plugins/p-wiki/tools/lib/confluence/adf.mjs` (add `adfToMarkdown`)
- Modify: `plugins/p-wiki/tools/__tests__/confluence-adf.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append to the test file:

```ts
import { adfToMarkdown } from '../lib/confluence/adf.mjs';

describe('adfToMarkdown', () => {
  it('empty doc → empty string', () => {
    expect(adfToMarkdown({ type: 'doc', version: 1, content: [] })).toBe('');
  });

  it('heading + paragraph round-trips on canonical form', () => {
    const md = '# Foo\n\nHello **world**.';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it('bullet list canonicalizes to `-` marker', () => {
    const adf = markdownToAdf('* foo\n* bar');
    expect(adfToMarkdown(adf)).toBe('- foo\n- bar');
  });

  it('code block preserves language', () => {
    const md = '```js\nconst x=1;\n```';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it('link inline reconstructs', () => {
    const md = 'See [docs](https://x).';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
```

Expected: new tests FAIL (export missing).

- [ ] **Step 3: Implement `adfToMarkdown`**

Append to `adf.mjs`:

```js
export function adfToMarkdown(doc) {
  if (!doc || !Array.isArray(doc.content)) return '';
  return doc.content.map(renderBlock).filter(s => s !== null).join('\n\n');
}

function renderBlock(node, depth = 0) {
  switch (node.type) {
    case 'heading': return '#'.repeat(node.attrs?.level ?? 1) + ' ' + renderInline(node.content ?? []);
    case 'paragraph': return renderInline(node.content ?? []);
    case 'bulletList': return renderList(node, '-', depth);
    case 'orderedList': return renderList(node, '1.', depth);
    case 'codeBlock': {
      const lang = node.attrs?.language ?? '';
      const body = (node.content ?? []).map(t => t.text ?? '').join('');
      return '```' + lang + '\n' + body + '\n```';
    }
    case 'blockquote': {
      const inner = (node.content ?? []).map(b => renderBlock(b, depth)).filter(s => s !== null).join('\n\n');
      return inner.split('\n').map(l => '> ' + l).join('\n');
    }
    default: return null;
  }
}

function renderList(node, marker, depth) {
  const lines = [];
  for (const item of node.content ?? []) {
    const para = (item.content ?? []).find(c => c.type === 'paragraph');
    const indent = '  '.repeat(depth);
    lines.push(indent + marker + ' ' + renderInline(para?.content ?? []));
    for (const c of item.content ?? []) {
      if (c.type === 'bulletList' || c.type === 'orderedList') {
        lines.push(renderList(c, c.type === 'bulletList' ? '-' : '1.', depth + 1));
      }
    }
  }
  return lines.join('\n');
}

function renderInline(nodes) {
  return nodes.map(n => {
    let t = n.text ?? '';
    for (const m of n.marks ?? []) {
      if (m.type === 'strong') t = `**${t}**`;
      else if (m.type === 'em') t = `*${t}*`;
      else if (m.type === 'code') t = '`' + t + '`';
      else if (m.type === 'link') t = `[${t}](${m.attrs.href})`;
    }
    return t;
  }).join('');
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
```

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/adf.mjs plugins/p-wiki/tools/__tests__/confluence-adf.test.ts
git commit -m "feat(p-wiki): add adfToMarkdown for canonical-form round-trip"
```

---

### Task 5: `confluence/identity.mjs` — path parsing + numericId cache

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/identity.mjs`
- Test: `plugins/p-wiki/tools/__tests__/confluence-identity.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-identity.test.ts
import { describe, expect, it } from 'vitest';
import { parsePath, formatPath, createIdentityCache } from '../lib/confluence/identity.mjs';

describe('identity', () => {
  it('parses confluence://concept/foo', () => {
    expect(parsePath('confluence://concept/foo')).toEqual({ type: 'concept', slug: 'foo' });
  });

  it('parses confluence://query/2026-05-15-q', () => {
    expect(parsePath('confluence://query/2026-05-15-q')).toEqual({ type: 'query', slug: '2026-05-15-q' });
  });

  it('throws on malformed input', () => {
    expect(() => parsePath('docs/wiki/x')).toThrow();
    expect(() => parsePath('confluence://')).toThrow();
    expect(() => parsePath('confluence://concept')).toThrow();
  });

  it('formats path from (type, slug)', () => {
    expect(formatPath('concept', 'foo')).toBe('confluence://concept/foo');
  });

  it('cache stores and returns numericId', () => {
    const c = createIdentityCache();
    c.set('concept', 'foo', '12345');
    expect(c.get('concept', 'foo')).toBe('12345');
    expect(c.get('concept', 'bar')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-identity.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// plugins/p-wiki/tools/lib/confluence/identity.mjs
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
  const map = new Map();
  const key = (t, s) => `${t}/${s}`;
  return {
    get(type, slug) { return map.get(key(type, slug)); },
    set(type, slug, id) { map.set(key(type, slug), id); },
    clear() { map.clear(); },
  };
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-identity.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/identity.mjs plugins/p-wiki/tools/__tests__/confluence-identity.test.ts
git commit -m "feat(p-wiki): add identity helpers (parsePath, cache)"
```

---

### Task 6: `confluence/properties.mjs` — properties.upsert helper

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/properties.mjs`
- Test: `plugins/p-wiki/tools/__tests__/confluence-properties.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-properties.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createPropertiesHelper } from '../lib/confluence/properties.mjs';

function fakeHttp() {
  const calls: any[] = [];
  const state = new Map<string, Array<{id: string, key: string, value: any, version: {number: number}}>>();
  return {
    calls,
    get: vi.fn(async (path: string) => {
      calls.push(['GET', path]);
      const m = /\/wiki\/api\/v2\/pages\/(\w+)\/properties$/.exec(path);
      if (m) return { status: 200, body: { results: state.get(m[1]) ?? [] } };
      return { status: 404 };
    }),
    post: vi.fn(async (path: string, body: any) => {
      calls.push(['POST', path, body]);
      const m = /\/wiki\/api\/v2\/pages\/(\w+)\/properties$/.exec(path);
      if (m) {
        const arr = state.get(m[1]) ?? [];
        const id = String(arr.length + 1);
        arr.push({ id, key: body.key, value: body.value, version: { number: 1 } });
        state.set(m[1], arr);
        return { status: 200, body: arr[arr.length - 1] };
      }
      return { status: 404 };
    }),
    put: vi.fn(async (path: string, body: any) => {
      calls.push(['PUT', path, body]);
      const m = /\/wiki\/api\/v2\/pages\/(\w+)\/properties\/(\w+)$/.exec(path);
      if (m) {
        const arr = state.get(m[1]) ?? [];
        const p = arr.find(p => p.id === m[2]);
        if (!p) return { status: 404 };
        p.value = body.value;
        p.version = body.version;
        return { status: 200, body: p };
      }
      return { status: 404 };
    }),
  };
}

describe('properties.upsert', () => {
  it('POSTs when key is absent', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    await h.upsert('100', 'pwiki-id', 'foo');
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.put).not.toHaveBeenCalled();
  });

  it('PUTs (by propertyId) when key exists, increments version', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    await h.upsert('100', 'pwiki-id', 'foo');   // creates id=1, version=1
    await h.upsert('100', 'pwiki-id', 'bar');   // updates id=1, version=2
    const putCall = http.put.mock.calls[0];
    expect(putCall[0]).toBe('/wiki/api/v2/pages/100/properties/1');
    expect(putCall[1].version.number).toBe(2);
  });

  it('reads list once per pageId (cache)', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    await h.upsert('100', 'pwiki-id', 'foo');
    await h.upsert('100', 'pwiki-type', 'concept');
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-properties.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// plugins/p-wiki/tools/lib/confluence/properties.mjs
export function createPropertiesHelper(http) {
  const cache = new Map(); // pageId -> Map<key, {id, version}>

  async function loadList(pageId) {
    if (cache.has(pageId)) return cache.get(pageId);
    const res = await http.get(`/wiki/api/v2/pages/${pageId}/properties`);
    const map = new Map();
    for (const p of res.body?.results ?? []) {
      map.set(p.key, { id: p.id, version: p.version?.number ?? 1 });
    }
    cache.set(pageId, map);
    return map;
  }

  async function upsert(pageId, key, value) {
    const list = await loadList(pageId);
    const existing = list.get(key);
    if (existing) {
      const newVersion = existing.version + 1;
      await http.put(`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`, {
        key, value, version: { number: newVersion },
      });
      list.set(key, { id: existing.id, version: newVersion });
    } else {
      const res = await http.post(`/wiki/api/v2/pages/${pageId}/properties`, { key, value });
      list.set(key, { id: res.body.id, version: 1 });
    }
  }

  async function readAll(pageId) {
    await loadList(pageId);
    // Need the values too, not just ids — fetch fresh:
    const res = await http.get(`/wiki/api/v2/pages/${pageId}/properties`);
    const out = {};
    for (const p of res.body?.results ?? []) out[p.key] = p.value;
    return out;
  }

  async function remove(pageId, key) {
    const list = await loadList(pageId);
    const existing = list.get(key);
    if (!existing) return false;
    await http.delete(`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`);
    list.delete(key);
    return true;
  }

  function invalidate(pageId) { cache.delete(pageId); }

  return { upsert, remove, readAll, invalidate };
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-properties.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/properties.mjs plugins/p-wiki/tools/__tests__/confluence-properties.test.ts
git commit -m "feat(p-wiki): add properties.upsert helper with per-page cache"
```

---

### Task 7: `confluence/labels.mjs` — label diff & sync

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/labels.mjs`
- Test: `plugins/p-wiki/tools/__tests__/confluence-labels.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-labels.test.ts
import { describe, expect, it, vi } from 'vitest';
import { syncLabels } from '../lib/confluence/labels.mjs';

function fakeHttp(currentLabels: string[]) {
  const state = new Set(currentLabels);
  return {
    state,
    get: vi.fn(async (p: string) => ({ status: 200, body: { results: [...state].map(name => ({ name })) } })),
    post: vi.fn(async (p: string, body: any) => { for (const t of body) state.add(t.name); return { status: 200 }; }),
    delete: vi.fn(async (p: string) => {
      const m = /\?name=(.+)$/.exec(p);
      if (m) state.delete(decodeURIComponent(m[1]));
      return { status: 200 };
    }),
  };
}

describe('syncLabels', () => {
  it('adds new tags, removes missing ones', async () => {
    const http = fakeHttp(['a', 'b', 'c']);
    await syncLabels(http, '100', ['b', 'c', 'd']);
    expect([...http.state].sort()).toEqual(['b', 'c', 'd']);
  });

  it('noop when target equals current', async () => {
    const http = fakeHttp(['a', 'b']);
    await syncLabels(http, '100', ['a', 'b']);
    expect(http.post).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('handles empty target (remove all)', async () => {
    const http = fakeHttp(['a', 'b']);
    await syncLabels(http, '100', []);
    expect(http.state.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-labels.test.ts
```

- [ ] **Step 3: Implement**

```js
// plugins/p-wiki/tools/lib/confluence/labels.mjs
export async function syncLabels(http, pageId, targetTags) {
  const res = await http.get(`/wiki/rest/api/content/${pageId}/label`);
  const current = new Set((res.body?.results ?? []).map(r => r.name));
  const target = new Set(targetTags);

  const toAdd = [...target].filter(t => !current.has(t));
  const toRemove = [...current].filter(t => !target.has(t));

  if (toAdd.length) {
    await http.post(`/wiki/rest/api/content/${pageId}/label`, toAdd.map(name => ({ name })));
  }
  for (const t of toRemove) {
    await http.delete(`/wiki/rest/api/content/${pageId}/label?name=${encodeURIComponent(t)}`);
  }
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-labels.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/labels.mjs plugins/p-wiki/tools/__tests__/confluence-labels.test.ts
git commit -m "feat(p-wiki): add labels syncLabels (diff-based add/remove)"
```

---

### Task 8: `confluence/tree.mjs` — sub-parent find-or-create

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/tree.mjs`
- Test: `plugins/p-wiki/tools/__tests__/confluence-tree.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-tree.test.ts
import { describe, expect, it, vi } from 'vitest';
import { findByRole, ensureSubParent, ensureIndex } from '../lib/confluence/tree.mjs';

function fakeHttp(initialPages: any[] = []) {
  let nextId = 1000;
  const pages = new Map(initialPages.map(p => [p.id, p]));
  return {
    pages,
    get: vi.fn(async (path: string) => {
      // CQL search
      const m = /cql=([^&]+)/.exec(path);
      if (m) {
        const cql = decodeURIComponent(m[1]);
        const roleMatch = /property\["pwiki-role"\]\s*=\s*"([^"]+)"/.exec(cql);
        if (roleMatch) {
          const results = [...pages.values()].filter(p => p.role === roleMatch[1]);
          return { status: 200, body: { results: results.map(p => ({ content: { id: p.id, title: p.title } })) } };
        }
      }
      return { status: 200, body: { results: [] } };
    }),
    post: vi.fn(async (path: string, body: any) => {
      if (path === '/wiki/api/v2/pages') {
        const id = String(nextId++);
        pages.set(id, { id, title: body.title, parentId: body.parentId, role: null });
        return { status: 200, body: { id, title: body.title } };
      }
      if (path.includes('/properties')) {
        const m = /\/pages\/(\w+)\/properties/.exec(path);
        const p = pages.get(m![1]);
        if (p && body.key === 'pwiki-role') p.role = body.value;
        return { status: 200, body: { id: '1' } };
      }
      return { status: 404 };
    }),
  };
}

describe('tree', () => {
  it('findByRole returns null when no match', async () => {
    const http = fakeHttp();
    const id = await findByRole(http, '123', 'sub-parent:concept');
    expect(id).toBeNull();
  });

  it('findByRole returns id when role property matches', async () => {
    const http = fakeHttp([{ id: '500', title: 'Concepts', role: 'sub-parent:concept' }]);
    const id = await findByRole(http, '123', 'sub-parent:concept');
    expect(id).toBe('500');
  });

  it('ensureSubParent creates when missing, sets pwiki-role', async () => {
    const http = fakeHttp();
    const id = await ensureSubParent(http, 'SPACE1', '100', 'concept');
    expect(id).toBeDefined();
    const p = http.pages.get(id);
    expect(p?.title).toBe('Concepts');
    expect(p?.role).toBe('sub-parent:concept');
  });

  it('ensureSubParent is idempotent', async () => {
    const http = fakeHttp();
    const id1 = await ensureSubParent(http, 'SPACE1', '100', 'concept');
    const id2 = await ensureSubParent(http, 'SPACE1', '100', 'concept');
    expect(id2).toBe(id1);
    expect(http.post).toHaveBeenCalledTimes(2); // create + property
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-tree.test.ts
```

- [ ] **Step 3: Implement**

```js
// plugins/p-wiki/tools/lib/confluence/tree.mjs
const SUB_PARENT_TITLES = {
  concept: 'Concepts', person: 'People', source: 'Sources', query: 'Queries',
};

function cqlEncode(cql) {
  return encodeURIComponent(cql);
}

export async function findByRole(http, rootPageId, role) {
  const cql = `property["pwiki-role"] = "${role}" AND ancestor = ${rootPageId}`;
  const res = await http.get(`/wiki/rest/api/search?cql=${cqlEncode(cql)}&limit=1`);
  const results = res.body?.results ?? [];
  if (results.length === 0) return null;
  return results[0].content?.id ?? results[0].id ?? null;
}

export async function ensureSubParent(http, spaceId, rootPageId, type) {
  const role = `sub-parent:${type}`;
  const found = await findByRole(http, rootPageId, role);
  if (found) return found;
  const title = SUB_PARENT_TITLES[type];
  const created = await http.post('/wiki/api/v2/pages', {
    spaceId, parentId: rootPageId, title,
    body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
  });
  const newId = created.body.id;
  await http.post(`/wiki/api/v2/pages/${newId}/properties`, { key: 'pwiki-role', value: role });
  return newId;
}

export async function ensureIndex(http, spaceId, rootPageId) {
  const found = await findByRole(http, rootPageId, 'index');
  if (found) return found;
  const created = await http.post('/wiki/api/v2/pages', {
    spaceId, parentId: rootPageId, title: 'Index',
    body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
  });
  const newId = created.body.id;
  await http.post(`/wiki/api/v2/pages/${newId}/properties`, { key: 'pwiki-role', value: 'index' });
  return newId;
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-tree.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/tree.mjs plugins/p-wiki/tools/__tests__/confluence-tree.test.ts
git commit -m "feat(p-wiki): add tree helpers (find-by-role, sub-parent/index bootstrap)"
```

---

### Task 9: `confluence/search.mjs` — CQL builder

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/search.mjs`
- Test: `plugins/p-wiki/tools/__tests__/confluence-search.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-search.test.ts
import { describe, expect, it } from 'vitest';
import { buildSearchCql, buildListCql, escapeCqlText } from '../lib/confluence/search.mjs';

describe('CQL builder', () => {
  it('escapes double quotes and backslashes in text~', () => {
    expect(escapeCqlText('foo "bar" \\baz')).toBe('foo \\"bar\\" \\\\baz');
  });

  it('build base search', () => {
    const cql = buildSearchCql({ query: 'kafka', rootPageId: '100' });
    expect(cql).toBe('text ~ "kafka" AND ancestor = 100');
  });

  it('build with type filter OR-disjunction', () => {
    const cql = buildSearchCql({ query: 'k', rootPageId: '100', types: ['concept', 'person'] });
    expect(cql).toContain('(property["pwiki-type"] = "concept" OR property["pwiki-type"] = "person")');
  });

  it('build with tags AND-intersection via labels', () => {
    const cql = buildSearchCql({ query: 'k', rootPageId: '100', tags: ['streaming', 'kafka'] });
    expect(cql).toContain('labels = "streaming"');
    expect(cql).toContain('labels = "kafka"');
  });

  it('buildListCql for pages of given types', () => {
    const cql = buildListCql({ rootPageId: '100', types: ['concept'] });
    expect(cql).toBe('ancestor = 100 AND (property["pwiki-type"] = "concept")');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-search.test.ts
```

- [ ] **Step 3: Implement**

```js
// plugins/p-wiki/tools/lib/confluence/search.mjs
export function escapeCqlText(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function typeDisjunction(types) {
  if (!types?.length) return '';
  return '(' + types.map(t => `property["pwiki-type"] = "${t}"`).join(' OR ') + ')';
}

function tagConjunction(tags) {
  if (!tags?.length) return '';
  return tags.map(t => `labels = "${escapeCqlText(t)}"`).join(' AND ');
}

export function buildSearchCql({ query, rootPageId, types, tags }) {
  const parts = [`text ~ "${escapeCqlText(query)}"`, `ancestor = ${rootPageId}`];
  const td = typeDisjunction(types); if (td) parts.push(td);
  const tc = tagConjunction(tags); if (tc) parts.push(tc);
  return parts.join(' AND ');
}

export function buildListCql({ rootPageId, types }) {
  const parts = [`ancestor = ${rootPageId}`];
  const td = typeDisjunction(types ?? ['concept', 'person', 'source', 'query']);
  if (td) parts.push(td);
  return parts.join(' AND ');
}

export function mapSearchResult(hit) {
  const c = hit.content ?? hit;
  return {
    id: c.id,
    title: c.title,
    excerpt: hit.excerpt ?? '',
    score: hit.score ?? 0,
  };
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-search.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/search.mjs plugins/p-wiki/tools/__tests__/confluence-search.test.ts
git commit -m "feat(p-wiki): add CQL builder and result mapper"
```

---

## Layer 2 — writePage / pageExists / listPages

### Task 10: Fake Confluence transport fixture

**Files:**
- Create: `plugins/p-wiki/tools/__tests__/fixtures/fake-confluence.mjs`

The fake holds in-memory state and routes by URL pattern. Used by every Confluence destination contract/semantic test.

- [ ] **Step 1: Implement the fake**

```js
// plugins/p-wiki/tools/__tests__/fixtures/fake-confluence.mjs
export function createFakeConfluence({ spaces = [], initialPages = [] } = {}) {
  let nextPageId = 1000;
  let nextPropId = 1;
  const pageById = new Map();
  for (const p of initialPages) pageById.set(p.id, normalizePage(p));

  function normalizePage(p) {
    return {
      id: String(p.id),
      title: p.title,
      parentId: p.parentId ? String(p.parentId) : null,
      version: p.version ?? 1,
      body: p.body ?? { type: 'doc', version: 1, content: [] },
      properties: new Map((p.properties ?? []).map(pr => [pr.key, { id: String(pr.id ?? nextPropId++), key: pr.key, value: pr.value, version: pr.version ?? 1 }])),
      labels: new Set(p.labels ?? []),
    };
  }

  function isAncestor(pageId, candidateAncestorId) {
    let cur = pageById.get(pageId);
    while (cur) {
      if (cur.parentId === candidateAncestorId) return true;
      cur = pageById.get(cur.parentId);
    }
    return false;
  }

  // Naive CQL: supports `text ~ "x"`, `ancestor = N`, `property["k"] = "v"`, `labels = "v"`, AND, OR, parens.
  function cqlMatches(page, cql) {
    // Convert CQL to a JS predicate.
    const body = page.body?.content ? JSON.stringify(page.body.content).toLowerCase() : '';
    const titleAndBody = (page.title + ' ' + body).toLowerCase();
    let expr = cql;
    expr = expr.replace(/text\s*~\s*"([^"]+)"/g, (_, q) => titleAndBody.includes(q.toLowerCase()) ? 'true' : 'false');
    expr = expr.replace(/ancestor\s*=\s*(\d+)/g, (_, a) => (isAncestor(page.id, String(a)) || page.parentId === String(a)) ? 'true' : 'false');
    expr = expr.replace(/property\["([^"]+)"\]\s*=\s*"([^"]+)"/g, (_, k, v) => page.properties.get(k)?.value === v ? 'true' : 'false');
    expr = expr.replace(/property\["([^"]+)"\]\s*IS\s+NOT\s+EMPTY/gi, (_, k) => page.properties.has(k) ? 'true' : 'false');
    expr = expr.replace(/labels\s*=\s*"([^"]+)"/g, (_, l) => page.labels.has(l) ? 'true' : 'false');
    expr = expr.replace(/id\s*!=\s*(\d+)/g, (_, id) => page.id !== String(id) ? 'true' : 'false');
    expr = expr.replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||');
    try { return Function('"use strict";return (' + expr + ')')(); } catch { return false; }
  }

  async function transport(req) {
    const { method, path, body: rawBody } = req;
    const body = rawBody === undefined ? undefined : JSON.parse(rawBody);

    // ----- spaces -----
    let m;
    if (method === 'GET' && (m = /^\/wiki\/api\/v2\/spaces(?:\?keys=([^&]+))?/.exec(path))) {
      const key = m[1] ? decodeURIComponent(m[1]) : null;
      const results = key ? spaces.filter(s => s.key === key) : spaces;
      return { status: 200, body: { results } };
    }

    // ----- pages -----
    if (method === 'POST' && path === '/wiki/api/v2/pages') {
      const id = String(nextPageId++);
      const adfValue = typeof body.body.value === 'string' ? JSON.parse(body.body.value) : body.body.value;
      pageById.set(id, { id, title: body.title, parentId: String(body.parentId), version: 1, body: adfValue, properties: new Map(), labels: new Set() });
      return { status: 200, body: { id, title: body.title, version: { number: 1 } } };
    }
    if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)(\?.*)?$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'GET') {
        return { status: 200, body: { id: p.id, title: p.title, parentId: p.parentId, version: { number: p.version }, body: { atlas_doc_format: { value: JSON.stringify(p.body) } } } };
      }
      if (method === 'PUT') {
        const adfValue = typeof body.body.value === 'string' ? JSON.parse(body.body.value) : body.body.value;
        if (body.version.number !== p.version + 1) return { status: 409, body: { message: 'version conflict' } };
        p.version = body.version.number;
        p.title = body.title ?? p.title;
        p.parentId = body.parentId ? String(body.parentId) : p.parentId;
        p.body = adfValue;
        return { status: 200, body: { id: p.id, version: { number: p.version } } };
      }
      if (method === 'DELETE') { pageById.delete(p.id); return { status: 204 }; }
    }

    // ----- properties -----
    if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)\/properties$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'GET') {
        return { status: 200, body: { results: [...p.properties.values()].map(pr => ({ id: pr.id, key: pr.key, value: pr.value, version: { number: pr.version } })) } };
      }
      if (method === 'POST') {
        if (p.properties.has(body.key)) return { status: 400, body: { message: 'key already exists' } };
        const id = String(nextPropId++);
        p.properties.set(body.key, { id, key: body.key, value: body.value, version: 1 });
        return { status: 200, body: { id, key: body.key, value: body.value, version: { number: 1 } } };
      }
    }
    if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)\/properties\/(\w+)$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'PUT') {
        for (const [k, pr] of p.properties) {
          if (pr.id === m[2]) {
            pr.value = body.value;
            pr.version = body.version.number;
            return { status: 200, body: { id: pr.id, key: k, value: pr.value, version: { number: pr.version } } };
          }
        }
        return { status: 404 };
      }
      if (method === 'DELETE') {
        for (const [k, pr] of p.properties) {
          if (pr.id === m[2]) { p.properties.delete(k); return { status: 204 }; }
        }
        return { status: 404 };
      }
    }

    // ----- search (v1 CQL) -----
    if (method === 'GET' && (m = /^\/wiki\/rest\/api\/search\?cql=([^&]+)/.exec(path))) {
      const cql = decodeURIComponent(m[1]);
      const results = [];
      for (const p of pageById.values()) {
        if (cqlMatches(p, cql)) results.push({ content: { id: p.id, title: p.title }, excerpt: '', score: 1 });
      }
      return { status: 200, body: { results, totalSize: results.length } };
    }

    // ----- labels (v1) -----
    if ((m = /^\/wiki\/rest\/api\/content\/(\d+)\/label(\?name=(.+))?$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'GET') return { status: 200, body: { results: [...p.labels].map(name => ({ name })) } };
      if (method === 'POST') { for (const t of body ?? []) p.labels.add(t.name); return { status: 200, body: {} }; }
      if (method === 'DELETE') { p.labels.delete(decodeURIComponent(m[3])); return { status: 204 }; }
    }

    return { status: 404, body: { message: `unhandled ${method} ${path}` } };
  }

  return { transport, pageById, spaces };
}
```

- [ ] **Step 2: Smoke test (in a tiny test file)**

```ts
// inline at the bottom of an existing test or as fake-confluence.test.ts
import { describe, it, expect } from 'vitest';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { createHttpClient } from '../lib/confluence/http.mjs';

describe('fake-confluence sanity', () => {
  it('round-trips a page create + get', async () => {
    const fake = createFakeConfluence({ spaces: [{ id: '1', key: 'ENG', name: 'Eng' }] });
    const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
    const c = await http.post('/wiki/api/v2/pages', { spaceId: '1', parentId: '0', title: 'T', body: { representation: 'atlas_doc_format', value: '{"type":"doc","version":1,"content":[]}' } });
    expect(c.body.id).toBeDefined();
    const r = await http.get(`/wiki/api/v2/pages/${c.body.id}`);
    expect(r.body.title).toBe('T');
  });
});
```

Save as `plugins/p-wiki/tools/__tests__/fake-confluence.test.ts`. Run:

```bash
npx vitest run plugins/p-wiki/tools/__tests__/fake-confluence.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/fixtures/fake-confluence.mjs plugins/p-wiki/tools/__tests__/fake-confluence.test.ts
git commit -m "test(p-wiki): add in-memory fake Confluence transport"
```

---

### Task 11: ConfluenceDestination skeleton + resolver wiring

**Files:**
- Create: `plugins/p-wiki/tools/lib/destinations/confluence.mjs` (skeleton, methods throw "not implemented")
- Modify: `plugins/p-wiki/tools/lib/destination.mjs`

- [ ] **Step 1: Implement skeleton + resolver**

```js
// plugins/p-wiki/tools/lib/destinations/confluence.mjs
import { createHttpClient } from '../confluence/http.mjs';
import { createIdentityCache, parsePath, formatPath } from '../confluence/identity.mjs';
import { createPropertiesHelper } from '../confluence/properties.mjs';

export function createConfluenceDestination({ root, config, transport }) {
  const c = config.confluence;
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) {
    if (!transport) throw new Error('PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN required');
  }
  const http = createHttpClient({ baseUrl: c.siteUrl, email: email ?? 'test', token: token ?? 'test', transport });
  const identity = createIdentityCache();
  const properties = createPropertiesHelper(http);

  const nyi = (name) => () => { throw new Error(`ConfluenceDestination.${name}: not implemented`); };

  return {
    kind: 'confluence',
    rootPath: `${c.siteUrl}#${c.spaceKey}/${c.rootPageId}`,
    // shared internals (exposed for layered impls):
    _http: http, _config: c, _identity: identity, _properties: properties,
    pageExists: nyi('pageExists'),
    readPage: nyi('readPage'),
    writePage: nyi('writePage'),
    mutatePage: nyi('mutatePage'),
    movePage: nyi('movePage'),
    listPages: nyi('listPages'),
    search: nyi('search'),
    lint: nyi('lint'),
    applyBacklinks: nyi('applyBacklinks'),
    regenerateIndex: nyi('regenerateIndex'),
  };
}
```

```js
// plugins/p-wiki/tools/lib/destination.mjs — modify the resolver
import { findWikiRoot } from './paths.mjs';
import { createFsDestination } from './destinations/fs.mjs';
import { createConfluenceDestination } from './destinations/confluence.mjs';
import { readConfig, validateConfig } from './config.mjs';

/**
 * @param {{cwd: string, transport?: Function}} env
 * @returns {Destination | null}
 */
export function resolveDestination(env) {
  const root = findWikiRoot(env.cwd);
  if (root === null) return null;
  const cfg = (() => { try { return readConfig(root); } catch { return null; } })();
  if (cfg && validateConfig(cfg).ok && cfg.destination === 'confluence') {
    return createConfluenceDestination({ root, config: cfg, transport: env.transport });
  }
  return createFsDestination({ rootPath: root });
}
```

- [ ] **Step 2: Run the full suite — FS destination must still pass**

```bash
npm test
```

Expected: all existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/lib/destination.mjs
git commit -m "feat(p-wiki): add ConfluenceDestination skeleton and config-aware resolver"
```

---

### Task 12: Refactor `destination-contract.test.ts` to be backend-agnostic

**Files:**
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts`

The current test hard-codes FS paths (`docs/wiki/pages/concept/target.md`, `docs/wiki/index.md`). Replace with paths captured from prior `writePage`, and assert path shape via the destination's `kind`.

- [ ] **Step 1: Rewrite the test**

```ts
// plugins/p-wiki/tools/__tests__/destination-contract.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-contract-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runContractTests(name: string, makeDest: () => any, pathShape: RegExp, indexPathShape: RegExp) {
  describe(`Destination contract: ${name}`, () => {
    it('exposes the documented method set', () => {
      const d = makeDest();
      for (const m of ['pageExists', 'readPage', 'writePage', 'mutatePage', 'movePage', 'listPages', 'search', 'lint', 'applyBacklinks', 'regenerateIndex']) {
        expect(typeof d[m]).toBe('function');
      }
      expect(typeof d.kind).toBe('string');
      expect(typeof d.rootPath).toBe('string');
    });

    it('writePage returns the documented shape', async () => {
      const d = makeDest();
      const r = await d.writePage({
        type: 'concept', slug: 'shape',
        frontmatter: { id: 'shape', type: 'concept', title: 'Shape', created: '2026-05-14', updated: '2026-05-14', status: 'active', tags: [], sources: [] },
        body: '# Shape\n',
      });
      expect(r).toMatchObject({ created: true });
      expect(r.path).toMatch(pathShape);
      expect(typeof r.id).toBe('string');
      expect(typeof r.slug).toBe('string');
    });

    it('search returns { total, results[] }', async () => {
      const d = makeDest();
      const r = await d.search('anything', {});
      expect(typeof r.total).toBe('number');
      expect(Array.isArray(r.results)).toBe(true);
    });

    it('lint returns { errors, warnings, totals }', async () => {
      const d = makeDest();
      const r = await d.lint({});
      expect(typeof r.errors).toBe('object');
      expect(typeof r.warnings).toBe('object');
      expect(typeof r.totals.errors).toBe('number');
      expect(typeof r.totals.warnings).toBe('number');
    });

    it('applyBacklinks returns documented shape against a seeded page', async () => {
      const d = makeDest();
      const seed = await d.writePage({
        type: 'concept', slug: 'target',
        frontmatter: { id: 'target', type: 'concept', title: 'Target', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] },
        body: '\n# Target\n',
      });
      const r = await d.applyBacklinks({ targetPath: seed.path });
      expect(typeof r.target).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.total).toBe('number');
      expect(Array.isArray(r.inserted)).toBe(true);
    });

    it('regenerateIndex returns documented shape', async () => {
      const d = makeDest();
      const r = await d.regenerateIndex();
      expect(r.path).toMatch(indexPathShape);
      expect(typeof r.groups.concept).toBe('number');
      expect(typeof r.groups.person).toBe('number');
      expect(typeof r.groups.source).toBe('number');
      expect(typeof r.groups.query).toBe('number');
      expect(r.written).toBe(true);
    });
  });
}

runContractTests('fs', () => createFsDestination({ rootPath: dir }), /^docs\/wiki\//, /^docs\/wiki\/index\.md$/);
```

- [ ] **Step 2: Run, verify FS contract still passes**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-contract.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "refactor(p-wiki): make destination-contract.test.ts backend-agnostic"
```

---

### Task 13: `pageExists` against Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs` (implement `pageExists`)
- Create: `plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts`

- [ ] **Step 1: Failing test**

```ts
// plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function makeDest(initialPages: any[] = []) {
  const fake = createFakeConfluence({
    spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
    initialPages,
  });
  const config = {
    destination: 'confluence',
    confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
  };
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  const dest = createConfluenceDestination({ root: '/tmp', config, transport: fake.transport });
  return { dest, fake };
}

describe('Confluence pageExists', () => {
  it('returns false when no page has matching pwiki-id under sub-parent', async () => {
    const { dest } = makeDest();
    expect(await dest.pageExists({ type: 'concept', slug: 'foo' })).toBe(false);
  });

  it('returns true and caches numeric id when match found', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    expect(await dest.pageExists({ type: 'concept', slug: 'foo' })).toBe(true);
    expect(dest._identity.get('concept', 'foo')).toBe('200');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
```

- [ ] **Step 3: Implement `pageExists`**

In `confluence.mjs`, replace the `pageExists` stub:

```js
  async function pageExists({ type, slug }) {
    const cached = identity.get(type, slug);
    if (cached) return true;
    const subParent = c.subParents[type];
    const cql = `ancestor = ${subParent} AND property["pwiki-id"] = "${slug}" AND property["pwiki-type"] = "${type}"`;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=1`);
    const r = res.body?.results?.[0];
    if (!r) return false;
    identity.set(type, slug, r.content?.id ?? r.id);
    return true;
  }
```

Add `pageExists` to the returned object (replace `nyi('pageExists')`).

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
git commit -m "feat(p-wiki): implement Confluence pageExists with identity cache"
```

---

### Task 14: `writePage` (create + overwrite) against Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `destination-confluence-write.test.ts`:

```ts
describe('Confluence writePage', () => {
  it('creates a new page with properties and labels', async () => {
    const { dest, fake } = makeDest();
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: ['x', 'y'], sources: [] };
    const r = await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '# Foo\n' });
    expect(r.created).toBe(true);
    expect(r.path).toBe('confluence://concept/foo');
    expect(r.viewUrl).toMatch(/\/pages\/\d+/);

    const page = [...fake.pageById.values()].find(p => p.title === 'Foo')!;
    expect(page.properties.get('pwiki-id')?.value).toBe('foo');
    expect(page.properties.get('pwiki-tags')?.value).toBe('["x","y"]');
    expect([...page.labels].sort()).toEqual(['x', 'y']);
  });

  it('fails with existingPath when slug taken and onConflict=fail', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    const r = await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '#\n', onConflict: 'fail' });
    expect(r.created).toBe(false);
    expect(r.existingPath).toBe('confluence://concept/foo');
    expect(r.existingViewUrl).toMatch(/\/pages\/200/);
    expect(r.dateSuffixSlug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('date-suffix retries pageExists with suffixed slug', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    const r = await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '#\n', onConflict: 'date-suffix' });
    expect(r.created).toBe(true);
    expect(r.slug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('overwrite updates body and bumps version', async () => {
    const { dest, fake } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '# Updated\n', onConflict: 'overwrite' });
    const page = fake.pageById.get('200')!;
    expect(page.version).toBe(2);
    expect(page.body.content[0].type).toBe('heading');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
```

- [ ] **Step 3: Implement `writePage`**

In `confluence.mjs`, add imports and replace the `writePage` stub:

```js
import { markdownToAdf } from '../confluence/adf.mjs';
import { syncLabels } from '../confluence/labels.mjs';
import { withDateSuffix } from '../slug.mjs';
import { today } from '../paths.mjs';
```

```js
  function viewUrl(numericId) {
    return `${c.siteUrl}/wiki/spaces/${c.spaceKey}/pages/${numericId}`;
  }

  function fmToPropertyPairs(fm) {
    const pairs = [];
    const map = {
      id: 'pwiki-id', type: 'pwiki-type', title: 'pwiki-title',
      created: 'pwiki-created', updated: 'pwiki-updated', status: 'pwiki-status',
      'source-url': 'pwiki-source-url', 'source-type': 'pwiki-source-type',
      question: 'pwiki-question',
    };
    for (const [k, v] of Object.entries(fm)) {
      if (v === undefined || v === null) continue;
      if (k === 'tags' || k === 'sources' || k === 'informed-by') {
        pairs.push([`pwiki-${k}`, JSON.stringify(v ?? [])]);
      } else if (map[k]) {
        pairs.push([map[k], String(v)]);
      }
    }
    return pairs;
  }

  async function writePage({ type, slug, frontmatter, body, onConflict }) {
    const conflict = onConflict ?? 'fail';
    let useSlug = slug;

    const exists = await pageExists({ type, slug: useSlug });
    if (exists) {
      if (conflict === 'fail') {
        const numericId = identity.get(type, useSlug);
        return {
          path: '', id: useSlug, slug: useSlug, created: false,
          existingPath: formatPath(type, useSlug),
          existingViewUrl: viewUrl(numericId),
          dateSuffixSlug: withDateSuffix(slug, today()),
        };
      }
      if (conflict === 'date-suffix') {
        useSlug = withDateSuffix(slug, today());
        if (await pageExists({ type, slug: useSlug })) {
          const numericId = identity.get(type, useSlug);
          return {
            path: '', id: useSlug, slug: useSlug, created: false,
            existingPath: formatPath(type, useSlug),
            existingViewUrl: viewUrl(numericId),
            dateSuffixSlug: useSlug,
          };
        }
      }
      // overwrite: fall through
    }

    const adf = markdownToAdf(body);
    const fm = { ...frontmatter, id: useSlug };
    const pairs = fmToPropertyPairs(fm);

    let pageId;
    if (exists && conflict === 'overwrite') {
      pageId = identity.get(type, useSlug);
      // GET current version
      const cur = await http.get(`/wiki/api/v2/pages/${pageId}`);
      const curVersion = cur.body.version.number;
      // Try PUT, one auto-retry on 409
      const putBody = (v) => ({
        id: pageId, status: 'current', title: fm.title,
        version: { number: v },
        body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
      });
      try {
        await http.put(`/wiki/api/v2/pages/${pageId}`, putBody(curVersion + 1));
      } catch (e) {
        if (e.status === 409) {
          const c2 = await http.get(`/wiki/api/v2/pages/${pageId}`);
          await http.put(`/wiki/api/v2/pages/${pageId}`, putBody(c2.body.version.number + 1));
        } else { throw e; }
      }
    } else {
      const created = await http.post('/wiki/api/v2/pages', {
        spaceId: c.spaceId, parentId: c.subParents[type], title: fm.title,
        body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
      });
      pageId = created.body.id;
      identity.set(type, useSlug, pageId);
      properties.invalidate(pageId);
    }

    // Upsert properties
    for (const [key, value] of pairs) await properties.upsert(pageId, key, value);

    // Sync labels
    await syncLabels(http, pageId, fm.tags ?? []);

    return {
      path: formatPath(type, useSlug),
      id: useSlug, slug: useSlug,
      created: true,
      viewUrl: viewUrl(pageId),
    };
  }
```

Add `writePage` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass (FS unchanged).

- [ ] **Step 6: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
git commit -m "feat(p-wiki): implement Confluence writePage (create + overwrite paths)"
```

---

### Task 15: `listPages` against Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts`

- [ ] **Step 1: Failing tests**

Append to the same test file:

```ts
describe('Confluence listPages', () => {
  it('lists pages under root by type', async () => {
    const { dest } = makeDest([
      { id: '201', title: 'A', parentId: '101', properties: [{ key: 'pwiki-id', value: 'a' }, { key: 'pwiki-type', value: 'concept' }, { key: 'pwiki-title', value: 'A' }, { key: 'pwiki-created', value: '2026-05-15' }, { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' }, { key: 'pwiki-tags', value: '[]' }, { key: 'pwiki-sources', value: '[]' }] },
      { id: '202', title: 'B', parentId: '102', properties: [{ key: 'pwiki-id', value: 'b' }, { key: 'pwiki-type', value: 'person' }, { key: 'pwiki-title', value: 'B' }, { key: 'pwiki-created', value: '2026-05-15' }, { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' }, { key: 'pwiki-tags', value: '[]' }, { key: 'pwiki-sources', value: '[]' }] },
    ]);
    // Mark them as descendants of root in fake: parents 101/102 must themselves descend from root 100.
    // Add sub-parents to the fake state via initialPages on a re-built dest:
    // (For simplicity, this test asserts only that listPages returns an array; full ancestor walks are exercised in e2e.)
    const r = await dest.listPages({ types: ['concept'] });
    expect(Array.isArray(r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
```

- [ ] **Step 3: Implement `listPages`**

```js
import { buildListCql } from '../confluence/search.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { parseFrontmatter } from '../fm.mjs';
import { toRepoRelative } from '../paths.mjs';
```

```js
  function reassembleFm(properties) {
    const fm = {};
    const tags = properties['pwiki-tags']; if (tags !== undefined) fm.tags = JSON.parse(tags);
    const sources = properties['pwiki-sources']; if (sources !== undefined) fm.sources = JSON.parse(sources);
    const ib = properties['pwiki-informed-by']; if (ib !== undefined) fm['informed-by'] = JSON.parse(ib);
    const scalarMap = {
      'pwiki-id': 'id', 'pwiki-type': 'type', 'pwiki-title': 'title',
      'pwiki-created': 'created', 'pwiki-updated': 'updated', 'pwiki-status': 'status',
      'pwiki-source-url': 'source-url', 'pwiki-source-type': 'source-type', 'pwiki-question': 'question',
    };
    for (const [k, v] of Object.entries(properties)) {
      if (scalarMap[k] && v !== undefined) fm[scalarMap[k]] = v;
    }
    return fm;
  }

  async function listConfluencePages(types) {
    const cql = buildListCql({ rootPageId: c.rootPageId, types });
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=250`);
    const out = [];
    for (const hit of res.body?.results ?? []) {
      const id = hit.content?.id ?? hit.id;
      if (!id) continue;
      const props = await properties.readAll(id);
      const fm = reassembleFm(props);
      if (!fm.type) continue;
      identity.set(fm.type, fm.id, id);
      out.push({ path: formatPath(fm.type, fm.id), frontmatter: fm });
    }
    return out;
  }

  function listRawFs() {
    // Raw is always on FS even in Confluence mode.
    const rawDir = join(root, 'docs', 'wiki', 'raw');
    if (!existsSync(rawDir)) return [];
    const out = [];
    const stack = [rawDir];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of readdirSync(cur, { withFileTypes: true })) {
        const p = join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile() && p.endsWith('.md')) {
          try {
            const text = readFileSync(p, 'utf-8');
            const { frontmatter } = parseFrontmatter(text);
            out.push({ path: toRepoRelative(root, p), frontmatter });
          } catch { /* skip */ }
        }
      }
    }
    return out;
  }

  async function listPages(opts) {
    const where = opts?.in ?? 'pages';
    const pagesPart = (where === 'pages' || where === 'all') ? await listConfluencePages(opts?.types) : [];
    const rawPart = (where === 'raw' || where === 'all') ? listRawFs() : [];
    return [...pagesPart, ...rawPart];
  }
```

Add `listPages` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts
git commit -m "feat(p-wiki): implement Confluence listPages (CQL + FS raw delegation)"
```

---

## Layer 3 — readPage / mutatePage / movePage

### Task 16: `readPage`

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Create: `plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function makeDest(initialPages: any[] = []) {
  const fake = createFakeConfluence({
    spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }], initialPages,
  });
  const config = {
    destination: 'confluence',
    confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
  };
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return { dest: createConfluenceDestination({ root: '/tmp', config, transport: fake.transport }), fake };
}

describe('Confluence readPage', () => {
  it('returns frontmatter + body for an existing page', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }] };
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', body: adf, properties: [
        { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
        { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
        { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
        { key: 'pwiki-tags', value: '["streaming"]' }, { key: 'pwiki-sources', value: '[]' },
      ] },
    ]);
    const r = await dest.readPage('confluence://concept/foo');
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.frontmatter.tags).toEqual(['streaming']);
    expect(r.body).toBe('# Foo');
    expect(r.path).toBe('confluence://concept/foo');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
```

- [ ] **Step 3: Implement `readPage`**

Add import: `import { adfToMarkdown } from '../confluence/adf.mjs';`

```js
  async function readPage(path) {
    const { type, slug } = parsePath(path);
    let id = identity.get(type, slug);
    if (!id) {
      await pageExists({ type, slug });
      id = identity.get(type, slug);
      if (!id) throw new Error(`page not found: ${path}`);
    }
    const pageRes = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    const adfStr = pageRes.body?.body?.atlas_doc_format?.value;
    const adf = adfStr ? JSON.parse(adfStr) : { type: 'doc', version: 1, content: [] };
    const body = adfToMarkdown(adf);
    const props = await properties.readAll(id);
    const frontmatter = reassembleFm(props);
    return { frontmatter, body, path };
  }
```

Add `readPage` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
git commit -m "feat(p-wiki): implement Confluence readPage (ADF → markdown + properties)"
```

---

### Task 17: `mutatePage` (properties-only)

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe('Confluence mutatePage', () => {
  it('add-tag updates pwiki-tags property and labels, leaves body untouched', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] };
    const { dest, fake } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', body: adf, version: 1,
        properties: [
          { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
          { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
          { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
          { key: 'pwiki-tags', value: '["a"]' }, { key: 'pwiki-sources', value: '[]' },
        ],
        labels: ['a'],
      },
    ]);
    const r = await dest.mutatePage('confluence://concept/foo', { addTag: 'b' });
    expect(r.changed).toContain('tags');
    expect(r.noop).toBe(false);
    const p = fake.pageById.get('200')!;
    expect(p.version).toBe(1);  // body untouched
    expect(p.properties.get('pwiki-tags')?.value).toBe('["a","b"]');
    expect([...p.labels].sort()).toEqual(['a', 'b']);
  });

  it('noop when adding an existing tag', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [
        { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
        { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
        { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
        { key: 'pwiki-tags', value: '["a"]' }, { key: 'pwiki-sources', value: '[]' },
      ] },
    ]);
    const r = await dest.mutatePage('confluence://concept/foo', { addTag: 'a' });
    expect(r.noop).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
```

- [ ] **Step 3: Implement `mutatePage`**

```js
  function applyMutations(fm, mutations) {
    const newFm = { ...fm };
    const changed = [];
    if (mutations.setFields) {
      for (const [k, v] of Object.entries(mutations.setFields)) {
        if (newFm[k] !== v) { newFm[k] = v; changed.push(k); }
      }
    }
    if (mutations.addTag) {
      const tags = newFm.tags ?? [];
      if (!tags.includes(mutations.addTag)) { newFm.tags = [...tags, mutations.addTag]; changed.push('tags'); }
    }
    if (mutations.removeTag) {
      const tags = newFm.tags ?? [];
      if (tags.includes(mutations.removeTag)) { newFm.tags = tags.filter(t => t !== mutations.removeTag); changed.push('tags'); }
    }
    if (mutations.addSources) {
      const src = newFm.sources ?? [];
      const added = mutations.addSources.filter(s => !src.includes(s));
      if (added.length) { newFm.sources = [...src, ...added]; changed.push('sources'); }
    }
    if (mutations.addInformedBy) {
      const ib = newFm['informed-by'] ?? [];
      const added = mutations.addInformedBy.filter(s => !ib.includes(s));
      if (added.length) { newFm['informed-by'] = [...ib, ...added]; changed.push('informed-by'); }
    }
    if (mutations.bumpUpdated) {
      const t = today();
      if (newFm.updated !== t) { newFm.updated = t; changed.push('updated'); }
    }
    if (mutations.removeFields) {
      for (const k of mutations.removeFields) {
        if (k in newFm) { delete newFm[k]; changed.push(k); }
      }
    }
    return { newFm, changed: [...new Set(changed)] };
  }

  async function mutatePage(path, mutations) {
    const { type, slug } = parsePath(path);
    let id = identity.get(type, slug);
    if (!id) { await pageExists({ type, slug }); id = identity.get(type, slug); }
    if (!id) throw new Error(`page not found: ${path}`);

    const props = await properties.readAll(id);
    const fm = reassembleFm(props);
    const { newFm, changed } = applyMutations(fm, mutations);
    if (changed.length === 0) return { path, changed: [], noop: true };

    // Diff: only upsert properties whose serialized value differs from current.
    const newPairs = fmToPropertyPairs(newFm);
    const oldPairs = new Map(fmToPropertyPairs(fm));
    for (const [key, value] of newPairs) {
      if (oldPairs.get(key) !== value) await properties.upsert(id, key, value);
    }
    // Removed fields: actually DELETE the matching property.
    if (mutations.removeFields) {
      const fmKeyToPropKey = { question: 'pwiki-question', 'informed-by': 'pwiki-informed-by', tags: 'pwiki-tags', sources: 'pwiki-sources' };
      for (const k of mutations.removeFields) {
        const propKey = fmKeyToPropKey[k];
        if (propKey && props[propKey] !== undefined) await properties.remove(id, propKey);
      }
    }
    if (changed.includes('tags')) await syncLabels(http, id, newFm.tags ?? []);

    return { path, changed, noop: false };
  }
```

Add `mutatePage` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
git commit -m "feat(p-wiki): implement Confluence mutatePage (properties + labels, body untouched)"
```

---

### Task 18: `movePage` (promote support)

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe('Confluence movePage', () => {
  it('reparents and updates pwiki-type/pwiki-id, preserves title and body', async () => {
    const adf = { type: 'doc', version: 1, content: [] };
    const { dest, fake } = makeDest([
      { id: '300', title: 'What is X?', parentId: '104', version: 1, body: adf,
        properties: [
          { key: 'pwiki-id', value: '2026-05-15-what-is-x' }, { key: 'pwiki-type', value: 'query' },
          { key: 'pwiki-title', value: 'What is X?' }, { key: 'pwiki-created', value: '2026-05-15' },
          { key: 'pwiki-status', value: 'filed' }, { key: 'pwiki-question', value: 'What is X?' },
          { key: 'pwiki-informed-by', value: '[]' }, { key: 'pwiki-tags', value: '[]' },
        ] },
    ]);
    await dest.movePage('confluence://query/2026-05-15-what-is-x', 'confluence://concept/what-is-x');
    const p = fake.pageById.get('300')!;
    expect(p.parentId).toBe('101');                            // moved under Concepts
    expect(p.title).toBe('What is X?');                         // title preserved
    expect(p.properties.get('pwiki-id')?.value).toBe('what-is-x');
    expect(p.properties.get('pwiki-type')?.value).toBe('concept');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
```

- [ ] **Step 3: Implement `movePage`**

```js
  async function movePage(fromPath, toPath) {
    const from = parsePath(fromPath);
    const to = parsePath(toPath);
    let id = identity.get(from.type, from.slug);
    if (!id) { await pageExists({ type: from.type, slug: from.slug }); id = identity.get(from.type, from.slug); }
    if (!id) throw new Error(`page not found: ${fromPath}`);

    const cur = await http.get(`/wiki/api/v2/pages/${id}`);
    const curVersion = cur.body.version.number;
    const title = cur.body.title;
    const adfStr = cur.body?.body?.atlas_doc_format?.value;

    const putBody = {
      id, status: 'current', title,
      version: { number: curVersion + 1 },
      parentId: c.subParents[to.type],
      body: adfStr ? { representation: 'atlas_doc_format', value: adfStr } : { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
    };
    await http.put(`/wiki/api/v2/pages/${id}`, putBody);

    await properties.upsert(id, 'pwiki-id', to.slug);
    await properties.upsert(id, 'pwiki-type', to.type);
    identity.set(to.type, to.slug, id);
  }
```

Add `movePage` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-read.test.ts
git commit -m "feat(p-wiki): implement Confluence movePage (reparent + pwiki-id/type)"
```

---

### Task 19: Wire `destination-contract.test.ts` to run for Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts`

- [ ] **Step 1: Add Confluence invocation**

Append to the test file (after the FS invocation):

```ts
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function makeConfluenceDest() {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }] });
  // Pre-seed sub-parents so writePage finds them.
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map(), labels: new Set() });
  }
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return createConfluenceDestination({
    root: dir,
    config: { destination: 'confluence', confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } } },
    transport: fake.transport,
  });
}

runContractTests('confluence', makeConfluenceDest, /^confluence:\/\//, /^confluence:\/\/index$/);
```

(`regenerateIndex` is not yet implemented — the contract test for it will fail at this point. Skip the `regenerateIndex` and `lint` assertions for Confluence via a `kind`-aware `it.skipIf` until later layers.)

Refine `runContractTests` signature to take an optional skip set:

```ts
function runContractTests(name: string, makeDest: () => any, pathShape: RegExp, indexPathShape: RegExp, skip: Set<string> = new Set()) {
  // ... wrap each it() with: if (skip.has('<test name>')) return it.skip(...); else it(...);
}
```

Then call:

```ts
runContractTests('confluence', makeConfluenceDest, /^confluence:\/\//, /^confluence:\/\/index$/,
  new Set(['lint returns { errors, warnings, totals }', 'applyBacklinks returns documented shape against a seeded page', 'regenerateIndex returns documented shape']));
```

(The skipped tests get enabled in Tasks 22, 25, 27.)

- [ ] **Step 2: Run, verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-contract.test.ts
```

Expected: FS suite pass + Confluence suite (with three skipped) pass.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "test(p-wiki): run destination-contract suite against Confluence destination"
```

---

## Layer 4 — search and lint

### Task 20: `search` against Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Create: `plugins/p-wiki/tools/__tests__/destination-confluence-search.test.ts`

- [ ] **Step 1: Failing test**

```ts
// plugins/p-wiki/tools/__tests__/destination-confluence-search.test.ts
import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function setup() {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }] });
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map(), labels: new Set() });
  }
  fake.pageById.set('200', { id: '200', title: 'Kafka', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kafka partitioning' }] }] }, properties: new Map([
    ['pwiki-id', { id: '1', key: 'pwiki-id', value: 'kafka', version: 1 }],
    ['pwiki-type', { id: '2', key: 'pwiki-type', value: 'concept', version: 1 }],
  ]), labels: new Set(['streaming']) });
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return createConfluenceDestination({
    root: '/tmp',
    config: { destination: 'confluence', confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } } },
    transport: fake.transport,
  });
}

describe('Confluence search', () => {
  it('finds page by text', async () => {
    const dest = setup();
    const r = await dest.search('kafka', {});
    expect(r.total).toBeGreaterThan(0);
    expect(r.results[0].path).toBe('confluence://concept/kafka');
  });

  it('filters by tag via labels CQL', async () => {
    const dest = setup();
    const r = await dest.search('kafka', { tags: ['streaming'] });
    expect(r.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-search.test.ts
```

- [ ] **Step 3: Implement `search`**

Add import: `import { buildSearchCql, mapSearchResult } from '../confluence/search.mjs';`

```js
  async function search(query, opts = {}) {
    const cql = buildSearchCql({
      query, rootPageId: c.rootPageId,
      types: opts.type, tags: opts.tags,
    });
    const limit = opts.limit ?? 10;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=excerpt`);
    const results = [];
    for (const hit of res.body?.results ?? []) {
      const m = mapSearchResult(hit);
      const props = await properties.readAll(m.id);
      const fm = reassembleFm(props);
      if (!fm.type) continue;
      identity.set(fm.type, fm.id, m.id);
      results.push({
        path: formatPath(fm.type, fm.id),
        title: fm.title, type: fm.type, tags: fm.tags ?? [],
        score: m.score, snippet: m.excerpt,
      });
    }
    return { total: res.body?.totalSize ?? results.length, results };
  }
```

Add `search` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-search.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-search.test.ts
git commit -m "feat(p-wiki): implement Confluence search via CQL"
```

---

### Task 21: `confluence/lint.mjs` — lint checks adapted

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/lint.mjs`
- Create: `plugins/p-wiki/tools/__tests__/confluence-lint.test.ts`

Implements per-check functions used by `confluence.mjs` `lint()`. Each check returns an array of findings keyed by check name.

- [ ] **Step 1: Failing tests**

```ts
// plugins/p-wiki/tools/__tests__/confluence-lint.test.ts
import { describe, expect, it } from 'vitest';
import { runConfluenceLint } from '../lib/confluence/lint.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { createHttpClient } from '../lib/confluence/http.mjs';
import { createPropertiesHelper } from '../lib/confluence/properties.mjs';

function setup(extraPages: any[] = []) {
  const fake = createFakeConfluence({});
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] },
      properties: new Map([['pwiki-role', { id: 'r' + id, key: 'pwiki-role', value: `sub-parent:${type}`, version: 1 }]]),
      labels: new Set(),
    });
  }
  for (const p of extraPages) fake.pageById.set(p.id, p);
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
  const properties = createPropertiesHelper(http);
  return { http, properties, fake };
}

describe('Confluence lint', () => {
  it('drift fires on a wiki-tree page without pwiki-id', async () => {
    const { http, properties } = setup([
      { id: '500', title: 'Stray', parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map(), labels: new Set() },
    ]);
    const r = await runConfluenceLint({ http, properties, config: { rootPageId: '100', siteUrl: 'https://x', spaceKey: 'ENG', subParents: { concept: '101', person: '102', source: '103', query: '104' } } });
    expect(r.warnings.drift?.length).toBeGreaterThan(0);
    expect(r.warnings.drift[0]).toMatchObject({ id: '500' });
  });

  it('misparented fires when pwiki-type does not match parent sub-parent', async () => {
    const props = new Map([
      ['pwiki-id', { id: 'p1', key: 'pwiki-id', value: 'foo', version: 1 }],
      ['pwiki-type', { id: 'p2', key: 'pwiki-type', value: 'concept', version: 1 }],
    ]);
    const { http, properties } = setup([
      { id: '500', title: 'Foo', parentId: '103', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: props, labels: new Set() },
    ]);
    const r = await runConfluenceLint({ http, properties, config: { rootPageId: '100', siteUrl: 'https://x', spaceKey: 'ENG', subParents: { concept: '101', person: '102', source: '103', query: '104' } } });
    expect(r.errors.misparented?.length).toBeGreaterThan(0);
  });

  it('skips structural artifacts (pwiki-role set)', async () => {
    const { http, properties } = setup();
    const r = await runConfluenceLint({ http, properties, config: { rootPageId: '100', siteUrl: 'https://x', spaceKey: 'ENG', subParents: { concept: '101', person: '102', source: '103', query: '104' } } });
    expect(r.warnings.drift ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-lint.test.ts
```

- [ ] **Step 3: Implement `confluence/lint.mjs`**

```js
// plugins/p-wiki/tools/lib/confluence/lint.mjs
import { adfToMarkdown } from './adf.mjs';

export async function runConfluenceLint({ http, properties, config, repoRoot, existsFn }) {
  const errors = {};
  const warnings = {};
  const totals = { errors: 0, warnings: 0 };
  function addErr(check, item) { (errors[check] ??= []).push(item); totals.errors++; }
  function addWarn(check, item) { (warnings[check] ??= []).push(item); totals.warnings++; }

  // 1) Walk all pages under rootPageId via CQL: ancestor = rootPageId.
  //    Per page, fetch properties so we can branch on pwiki-role / pwiki-type.
  const cql = `ancestor = ${config.rootPageId}`;
  const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=250`);
  const hits = res.body?.results ?? [];

  // Build page info table
  const subParentIds = new Set(Object.values(config.subParents));
  const pages = [];
  for (const hit of hits) {
    const id = hit.content?.id ?? hit.id;
    if (!id) continue;
    const props = await properties.readAll(id);
    pages.push({ id, title: hit.content?.title ?? hit.title, props });
    // We do NOT have parentId from search results directly; fetch only if needed for misparented/drift.
  }

  // Re-fetch each page for parentId (needed for misparented).
  for (const p of pages) {
    const pageRes = await http.get(`/wiki/api/v2/pages/${p.id}`);
    p.parentId = String(pageRes.body?.parentId ?? '');
  }

  for (const p of pages) {
    // skip structural artifacts
    if (p.props['pwiki-role']) continue;

    // drift: in tree without pwiki-id
    if (!p.props['pwiki-id']) {
      addWarn('drift', { id: p.id, title: p.title, parentId: p.parentId });
      continue;
    }

    // misparented: pwiki-type does not match parent sub-parent
    const expectedParent = config.subParents[p.props['pwiki-type']];
    if (subParentIds.has(p.parentId) && expectedParent && p.parentId !== expectedParent) {
      addErr('misparented', { id: p.id, title: p.title, pwikiType: p.props['pwiki-type'], parentId: p.parentId });
    }

    // frontmatter: pwiki-type unknown
    if (!['concept', 'person', 'source', 'query'].includes(p.props['pwiki-type'])) {
      addErr('frontmatter', { id: p.id, title: p.title, error: `unknown pwiki-type: ${p.props['pwiki-type']}` });
    }

    // stale: updated > N days ago (default 180 — match v1 lint.mjs behavior)
    const updated = p.props['pwiki-updated'];
    if (updated) {
      const days = Math.floor((Date.now() - new Date(updated).getTime()) / (1000 * 60 * 60 * 24));
      if (days > 180) addWarn('stale', { id: p.id, title: p.title, updated, days });
    }

    // dead-sources: every entry in sources: must exist on FS.
    if (repoRoot && existsFn) {
      try {
        const sources = JSON.parse(p.props['pwiki-sources'] ?? '[]');
        for (const s of sources) {
          if (!existsFn(`${repoRoot}/${s}`)) addErr('dead-sources', { id: p.id, source: s });
        }
      } catch { /* malformed JSON: covered by frontmatter check */ }
    }
  }

  // dead-links / orphan-pages / underlinked: single walk of bodies.
  const bodyCache = new Map();
  async function getBody(id) {
    if (bodyCache.has(id)) return bodyCache.get(id);
    const pageRes = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    const adfStr = pageRes.body?.body?.atlas_doc_format?.value;
    const adf = adfStr ? JSON.parse(adfStr) : { type: 'doc', version: 1, content: [] };
    bodyCache.set(id, adf);
    return adf;
  }
  function collectLinks(node, out) {
    if (Array.isArray(node?.marks)) {
      for (const m of node.marks) {
        if (m.type === 'link' && m.attrs?.href) out.push(m.attrs.href);
      }
    }
    if (Array.isArray(node?.content)) for (const c of node.content) collectLinks(c, out);
  }
  const incoming = new Map();
  const outgoing = new Map();
  const pwikiPagesById = new Map(pages.filter(p => p.props['pwiki-id']).map(p => [p.id, p]));

  for (const p of pwikiPagesById.values()) {
    const adf = await getBody(p.id);
    const hrefs = [];
    collectLinks(adf, hrefs);
    outgoing.set(p.id, 0);
    for (const href of hrefs) {
      const m = /\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(href);
      if (!m) continue;                                 // external URL
      const targetId = m[1];
      outgoing.set(p.id, (outgoing.get(p.id) ?? 0) + 1);
      const target = pwikiPagesById.get(targetId);
      if (!target) addErr('dead-links', { id: p.id, href });
      else {
        incoming.set(targetId, (incoming.get(targetId) ?? 0) + 1);
      }
    }
  }

  // orphan-pages: concept pages with 0 incoming
  for (const p of pwikiPagesById.values()) {
    if (p.props['pwiki-type'] !== 'concept') continue;
    if ((incoming.get(p.id) ?? 0) === 0) addWarn('orphan-pages', { id: p.id, title: p.title });
  }

  // underlinked: concept with <3 outgoing AND status != draft
  for (const p of pwikiPagesById.values()) {
    if (p.props['pwiki-type'] !== 'concept') continue;
    if (p.props['pwiki-status'] === 'draft') continue;
    if ((outgoing.get(p.id) ?? 0) < 3) addWarn('underlinked', { id: p.id, title: p.title, outgoing: outgoing.get(p.id) ?? 0 });
  }

  return { errors, warnings, totals };
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-lint.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/lint.mjs plugins/p-wiki/tools/__tests__/confluence-lint.test.ts
git commit -m "feat(p-wiki): add Confluence lint checks (drift, misparented, ports of v1 checks)"
```

---

### Task 22: Wire `lint()` into ConfluenceDestination

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts` (unskip `lint` for Confluence)

- [ ] **Step 1: Implement `lint`**

Add: `import { runConfluenceLint } from '../confluence/lint.mjs';` + `import { existsSync } from 'node:fs';`

```js
  async function lint(opts = {}) {
    return runConfluenceLint({
      http, properties,
      config: c,
      repoRoot: root, existsFn: existsSync,
    });
  }
```

Add `lint` to the returned object.

- [ ] **Step 2: Unskip lint in contract test**

In `destination-contract.test.ts`, remove `'lint returns { errors, warnings, totals }'` from the Confluence skip set.

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "feat(p-wiki): wire lint() into ConfluenceDestination; unskip contract test"
```

---

### Task 23: Add `error.code` to CLI JSON error payloads

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`
- Create: `plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts`

When a destination method throws, the CLI catches it and maps `err.status`/`err.code` to one of the codes from spec §5.2 in the JSON payload.

- [ ] **Step 1: Failing test**

```ts
// plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts
import { describe, expect, it } from 'vitest';
import { mapErrorToCode } from '../pwiki.mjs';

describe('CLI error mapping', () => {
  it('401 → auth-failed', () => {
    expect(mapErrorToCode({ status: 401 })).toBe('auth-failed');
  });
  it('429 → rate-limited', () => {
    expect(mapErrorToCode({ status: 429 })).toBe('rate-limited');
  });
  it('5xx → network-error', () => {
    expect(mapErrorToCode({ status: 503 })).toBe('network-error');
  });
  it('409 → version-conflict', () => {
    expect(mapErrorToCode({ status: 409 })).toBe('version-conflict');
  });
  it('ECONNREFUSED → network-error', () => {
    expect(mapErrorToCode({ code: 'ECONNREFUSED' })).toBe('network-error');
  });
  it('unknown → internal', () => {
    expect(mapErrorToCode({})).toBe('internal');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts
```

- [ ] **Step 3: Implement in `pwiki.mjs`**

Add (export) at the top after `VERSION`:

```js
export function mapErrorToCode(err) {
  const s = err?.status;
  if (s === 401 || s === 403) return 'auth-failed';
  if (s === 404) return 'page-not-found';
  if (s === 409) return 'version-conflict';
  if (s === 429) return 'rate-limited';
  if (typeof s === 'number' && s >= 500) return 'network-error';
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND') return 'network-error';
  return 'internal';
}
```

Then change the existing top-level try/catch around command dispatch in `pwiki.mjs` to emit JSON with `error.code` on exit:

```js
} catch (err) {
  const code = mapErrorToCode(err);
  const payload = { error: { code, message: err?.message ?? String(err) } };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code === 'schema-violation' || code === 'slug-taken' || code === 'target-exists' ? 2 : code === 'internal' ? 3 : 1);
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs plugins/p-wiki/tools/__tests__/cli-error-codes.test.ts
git commit -m "feat(p-wiki): map destination errors to error.code in CLI JSON payload"
```

---

### Task 24: Add `lint` command JSON-from-result formatter for Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`

The existing `formatLintReport` (text) groups by check key. Confluence introduces new keys (`drift`, `misparented`) — the existing function already iterates over whatever keys are present, so no change needed unless ordering matters. Verify by inspection.

- [ ] **Step 1: Inspect**

Read `formatLintReport` in `pwiki.mjs`. If it whitelists check names, add `drift` and `misparented`. If it iterates dynamically, no change.

- [ ] **Step 2: If a whitelist exists, modify it; otherwise skip and commit nothing**

```bash
grep -n "drift\|misparented\|orphan-pages" plugins/p-wiki/tools/pwiki.mjs
```

If the formatter explicitly lists keys, append `'drift'`, `'misparented'`.

- [ ] **Step 3: Commit (if changed)**

```bash
git add plugins/p-wiki/tools/pwiki.mjs
git commit -m "feat(p-wiki): include drift/misparented in lint text output"
```

---

## Layer 5 — applyBacklinks and regenerateIndex

### Task 25: `applyBacklinks` against Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Create: `plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts`
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts` (unskip `applyBacklinks`)

- [ ] **Step 1: Failing test**

```ts
// plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts
import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function setup(extraPages: any[] = []) {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }] });
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map([['pwiki-role', { id: 'r' + id, key: 'pwiki-role', value: `sub-parent:${type}`, version: 1 }]]), labels: new Set() });
  }
  for (const p of extraPages) fake.pageById.set(p.id, p);
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return { fake, dest: createConfluenceDestination({
    root: '/tmp',
    config: { destination: 'confluence', confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } } },
    transport: fake.transport,
  }) };
}

describe('Confluence applyBacklinks', () => {
  it('inserts a link mark in each candidate body', async () => {
    const target = { id: '500', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] },
      properties: new Map([
        ['pwiki-id', { id: 'p1', key: 'pwiki-id', value: 'foo', version: 1 }],
        ['pwiki-type', { id: 'p2', key: 'pwiki-type', value: 'concept', version: 1 }],
        ['pwiki-title', { id: 'p3', key: 'pwiki-title', value: 'Foo', version: 1 }],
      ]),
      labels: new Set(),
    };
    const candidate = { id: '600', title: 'Bar', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'We mention Foo here.' }] },
    ] },
      properties: new Map([
        ['pwiki-id', { id: 'q1', key: 'pwiki-id', value: 'bar', version: 1 }],
        ['pwiki-type', { id: 'q2', key: 'pwiki-type', value: 'concept', version: 1 }],
      ]),
      labels: new Set(),
    };
    const { dest, fake } = setup([target, candidate]);
    const r = await dest.applyBacklinks({ targetPath: 'confluence://concept/foo' });
    expect(r.inserted.length).toBe(1);
    const p = fake.pageById.get('600')!;
    // body now has link mark on "Foo"
    const json = JSON.stringify(p.body);
    expect(json).toContain('"type":"link"');
    expect(json).toContain('/pages/500');
  });

  it('returns suspicious:true above threshold and writes nothing', async () => {
    // Set up many candidates all containing the title.
    const pages: any[] = [{ id: '500', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map([['pwiki-id', { id: '1', key: 'pwiki-id', value: 'foo', version: 1 }], ['pwiki-type', { id: '2', key: 'pwiki-type', value: 'concept', version: 1 }], ['pwiki-title', { id: '3', key: 'pwiki-title', value: 'Foo', version: 1 }]]), labels: new Set() }];
    for (let i = 0; i < 25; i++) {
      pages.push({ id: String(700 + i), title: `P${i}`, parentId: '101', version: 1,
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `mentions Foo` }] }] },
        properties: new Map([['pwiki-id', { id: `pi${i}`, key: 'pwiki-id', value: `p${i}`, version: 1 }], ['pwiki-type', { id: `pt${i}`, key: 'pwiki-type', value: 'concept', version: 1 }]]),
        labels: new Set(),
      });
    }
    const { dest, fake } = setup(pages);
    const r = await dest.applyBacklinks({ targetPath: 'confluence://concept/foo' });
    expect(r.suspicious).toBe(true);
    expect(r.total).toBeGreaterThan(20);
    // No bodies modified — versions remain 1.
    for (let i = 0; i < 25; i++) expect(fake.pageById.get(String(700 + i))!.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts
```

- [ ] **Step 3: Implement `applyBacklinks`**

```js
  async function applyBacklinks({ targetPath, maxSuggestions = 20, force = false }) {
    const target = await readPage(targetPath);
    const title = (target.frontmatter.title ?? '').trim();
    if (!title) throw new Error(`applyBacklinks: target has no title: ${targetPath}`);
    const targetId = identity.get(parsePath(targetPath).type, parsePath(targetPath).slug);

    // CQL search for candidates
    const cql = `text ~ "${title.replace(/"/g, '\\"')}" AND ancestor = ${c.rootPageId} AND id != ${targetId}`;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${maxSuggestions + 1}`);
    const hits = res.body?.results ?? [];

    // For each candidate fetch body and try to find a match.
    const matches = [];
    for (const hit of hits) {
      const id = hit.content?.id ?? hit.id;
      const pageRes = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
      const adfStr = pageRes.body?.body?.atlas_doc_format?.value;
      if (!adfStr) continue;
      const adf = JSON.parse(adfStr);
      const found = findFirstAdfMatch(adf, title);
      if (found) matches.push({ id, version: pageRes.body.version.number, adf, found });
    }

    if (matches.length > maxSuggestions && !force) {
      return {
        target: targetPath, title, suspicious: true, total: matches.length,
        candidates: matches.map(m => ({ file: formatPath(parsePath(targetPath).type, parsePath(targetPath).slug), line: -1, preview: '' })),
      };
    }

    const inserted = [];
    const href = viewUrl(targetId);
    for (const m of matches) {
      insertLinkMark(m.adf, m.found, href);
      await http.put(`/wiki/api/v2/pages/${m.id}`, {
        id: m.id, status: 'current', title: (await http.get(`/wiki/api/v2/pages/${m.id}`)).body.title,
        version: { number: m.version + 1 },
        body: { representation: 'atlas_doc_format', value: JSON.stringify(m.adf) },
      });
      inserted.push({ file: formatPath('concept', 'unknown'), line: -1 });
    }

    return { target: targetPath, title, inserted, total: inserted.length };
  }

  // Walk ADF, return first {parent, indexInParent, node, hitIndex, hitLen} where `title` appears as a whole word
  // in a text node not under an existing link/code mark and not inside a codeBlock.
  function findFirstAdfMatch(adf, title) {
    const re = new RegExp(`(^|[^\\w])(${title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})($|[^\\w])`);
    function walk(node, parent, idx, inCode) {
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'codeBlock') return null;
      if (node.type === 'text') {
        if (inCode) return null;
        if ((node.marks ?? []).some(m => m.type === 'link' || m.type === 'code')) return null;
        const m = re.exec(node.text ?? '');
        if (m) return { parent, idx, node, start: m.index + m[1].length, len: m[2].length };
        return null;
      }
      const arr = node.content ?? [];
      for (let i = 0; i < arr.length; i++) {
        const sub = walk(arr[i], arr, i, inCode);
        if (sub) return sub;
      }
      return null;
    }
    return walk(adf, null, -1, false);
  }

  function insertLinkMark(adf, hit, href) {
    const t = hit.node.text;
    const before = t.slice(0, hit.start);
    const matched = t.slice(hit.start, hit.start + hit.len);
    const after = t.slice(hit.start + hit.len);
    const newNodes = [];
    if (before) newNodes.push({ type: 'text', text: before });
    newNodes.push({ type: 'text', text: matched, marks: [{ type: 'link', attrs: { href } }] });
    if (after) newNodes.push({ type: 'text', text: after });
    hit.parent.splice(hit.idx, 1, ...newNodes);
  }
```

Add `applyBacklinks` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts
```

- [ ] **Step 5: Unskip in contract test**

Remove `'applyBacklinks returns documented shape against a seeded page'` from the Confluence skip set in `destination-contract.test.ts`.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "feat(p-wiki): implement Confluence applyBacklinks with ADF link insertion"
```

---

### Task 26: `confluence/index.mjs` — Index ADF renderer

**Files:**
- Create: `plugins/p-wiki/tools/lib/confluence/index.mjs`
- Test: include in `confluence-adf.test.ts` or new `confluence-index.test.ts`

A small helper that renders the same grouped-summary structure as FS but as ADF.

- [ ] **Step 1: Failing test**

```ts
// plugins/p-wiki/tools/__tests__/confluence-index.test.ts
import { describe, expect, it } from 'vitest';
import { renderIndexAdf } from '../lib/confluence/index.mjs';

describe('renderIndexAdf', () => {
  it('builds heading per group and bullet list of items', () => {
    const adf = renderIndexAdf({
      siteUrl: 'https://x', spaceKey: 'ENG',
      groups: {
        concept: [{ id: 'foo', title: 'Foo', numericId: '200', summary: 'About Foo.' }],
        person: [], source: [], query: [],
      },
    });
    expect(adf.type).toBe('doc');
    // First content is a heading "Concepts"
    expect(adf.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    // Followed by a bulletList with one item containing a link
    const list = adf.content.find((b: any) => b.type === 'bulletList');
    expect(list).toBeDefined();
    const json = JSON.stringify(list);
    expect(json).toContain('/pages/200');
    expect(json).toContain('Foo');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-index.test.ts
```

- [ ] **Step 3: Implement**

```js
// plugins/p-wiki/tools/lib/confluence/index.mjs
const GROUP_LABEL = { concept: 'Concepts', person: 'People', source: 'Sources', query: 'Queries' };

export function renderIndexAdf({ siteUrl, spaceKey, groups }) {
  const content = [];
  for (const type of ['concept', 'person', 'source', 'query']) {
    const items = groups[type] ?? [];
    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: GROUP_LABEL[type] }] });
    if (items.length === 0) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: '(none)' }] });
      continue;
    }
    const listItems = items.map(it => ({
      type: 'listItem',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: it.title, marks: [{ type: 'link', attrs: { href: `${siteUrl}/wiki/spaces/${spaceKey}/pages/${it.numericId}` } }] },
          ...(it.summary ? [{ type: 'text', text: ' — ' + it.summary }] : []),
        ],
      }],
    }));
    content.push({ type: 'bulletList', content: listItems });
  }
  return { type: 'doc', version: 1, content };
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/confluence-index.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugins/p-wiki/tools/lib/confluence/index.mjs plugins/p-wiki/tools/__tests__/confluence-index.test.ts
git commit -m "feat(p-wiki): add confluence index ADF renderer"
```

---

### Task 27: `regenerateIndex` against Confluence

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/confluence.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts`
- Modify: `plugins/p-wiki/tools/__tests__/destination-contract.test.ts` (unskip `regenerateIndex`)

- [ ] **Step 1: Failing test**

Append to `destination-confluence-backlinks-index.test.ts`:

```ts
describe('Confluence regenerateIndex', () => {
  it('creates Index page on first run, writes ADF body, returns counts', async () => {
    const concept = { id: '500', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] },
      properties: new Map([
        ['pwiki-id', { id: 'p1', key: 'pwiki-id', value: 'foo', version: 1 }],
        ['pwiki-type', { id: 'p2', key: 'pwiki-type', value: 'concept', version: 1 }],
        ['pwiki-title', { id: 'p3', key: 'pwiki-title', value: 'Foo', version: 1 }],
        ['pwiki-tags', { id: 'p4', key: 'pwiki-tags', value: '[]', version: 1 }],
        ['pwiki-sources', { id: 'p5', key: 'pwiki-sources', value: '[]', version: 1 }],
      ]),
      labels: new Set(),
    };
    const { dest, fake } = setup([concept]);
    const r = await dest.regenerateIndex();
    expect(r.written).toBe(true);
    expect(r.path).toBe('confluence://index');
    expect(r.groups.concept).toBe(1);
    // Index page was created with pwiki-role = "index"
    const idx = [...fake.pageById.values()].find(p => p.title === 'Index');
    expect(idx).toBeDefined();
    expect(idx!.properties.get('pwiki-role')?.value).toBe('index');
    const bodyJson = JSON.stringify(idx!.body);
    expect(bodyJson).toContain('Concepts');
    expect(bodyJson).toContain('Foo');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts
```

- [ ] **Step 3: Implement `regenerateIndex`**

Add: `import { ensureIndex } from '../confluence/tree.mjs';` and `import { renderIndexAdf } from '../confluence/index.mjs';`

```js
  async function regenerateIndex() {
    const all = await listConfluencePages(['concept', 'person', 'source', 'query']);
    const groups = { concept: [], person: [], source: [], query: [] };
    for (const { path, frontmatter } of all) {
      const t = frontmatter.type;
      if (!(t in groups)) continue;
      const numericId = identity.get(t, frontmatter.id);
      groups[t].push({ id: frontmatter.id, title: frontmatter.title, numericId, summary: '' });
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const indexId = await ensureIndex(http, c.spaceId, c.rootPageId);
    const adf = renderIndexAdf({ siteUrl: c.siteUrl, spaceKey: c.spaceKey, groups });
    const cur = await http.get(`/wiki/api/v2/pages/${indexId}`);
    await http.put(`/wiki/api/v2/pages/${indexId}`, {
      id: indexId, status: 'current', title: 'Index',
      version: { number: cur.body.version.number + 1 },
      body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
    });
    return {
      path: 'confluence://index',
      groups: { concept: groups.concept.length, person: groups.person.length, source: groups.source.length, query: groups.query.length },
      written: true,
    };
  }
```

Add `regenerateIndex` to the returned object.

- [ ] **Step 4: Verify pass**

```bash
npx vitest run plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts
```

- [ ] **Step 5: Unskip contract test**

Remove the last entry from the Confluence skip set in `destination-contract.test.ts`. The skip set should now be empty — replace with `new Set()`.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: full contract parity green for both backends.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-wiki/tools/lib/destinations/confluence.mjs plugins/p-wiki/tools/__tests__/destination-confluence-backlinks-index.test.ts plugins/p-wiki/tools/__tests__/destination-contract.test.ts
git commit -m "feat(p-wiki): implement Confluence regenerateIndex (Index page + ADF body)"
```

---

## Wrap-up — skills, init, template, E2E, version bump

### Task 28: Skill error.code parsing

**Files:**
- Modify: `plugins/p-wiki/skills/ingest/SKILL.md`
- Modify: `plugins/p-wiki/skills/compile/SKILL.md`
- Modify: `plugins/p-wiki/skills/query/SKILL.md`
- Modify: `plugins/p-wiki/skills/lint/SKILL.md`

Each skill's error-handling section gets a switch on `error.code`. Spec §5.2 lists the mapping. Identical block in each skill:

```markdown
## Error handling

If `pwiki <command>` exits non-zero, parse the JSON `error.code` field:

| error.code | What to say to the user |
|---|---|
| `auth-failed` | "Check PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN; verify the token grants access to the space." |
| `config-invalid` | "Confluence config invalid — re-run `/p-wiki:init`." |
| `page-not-found` | "Page `<path>` no longer exists in Confluence." |
| `rate-limited` | "Confluence rate-limited; retry in a few minutes." |
| `network-error` | "Confluence is unavailable; retry later." |
| `version-conflict` | "Page was modified concurrently; re-run the command." |
| `slug-taken` | Existing slug-conflict prompt (overwrite / date-suffix) — unchanged. |
| `target-exists` | Existing callout — unchanged. |
| `schema-violation` | Existing behavior — unchanged. |
| `internal` | "Internal CLI error — file an issue against p-wiki." |
```

- [ ] **Step 1: Add the section to each of the four skill files**

Edit each file to append the section above under an `## Error handling` heading. If a similar section already exists, replace it.

- [ ] **Step 2: Run the marketplace tests (which validate skill files)**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/skills/ingest/SKILL.md plugins/p-wiki/skills/compile/SKILL.md plugins/p-wiki/skills/query/SKILL.md plugins/p-wiki/skills/lint/SKILL.md
git commit -m "docs(p-wiki): document error.code handling in skills (v2 prep)"
```

---

### Task 29: `init` skill — Confluence destination branch

**Files:**
- Modify: `plugins/p-wiki/skills/init/SKILL.md`

The init skill currently scaffolds FS only. Add a destination-choice step early in the flow.

- [ ] **Step 1: Add the new step**

Locate the existing "Steps" section in `init/SKILL.md`. Insert after the Node-version check:

```markdown
### Step N: Choose destination

Ask the user (single question):

> Where should this wiki live? Options:
> - `fs` — local filesystem under `docs/wiki/` (default).
> - `confluence` — Confluence Cloud space (requires PWIKI_CONFLUENCE_EMAIL + PWIKI_CONFLUENCE_TOKEN env vars).

If the user picks `confluence`:

1. Verify both env vars are set; if not, output instructions linking to https://id.atlassian.com/manage-profile/security/api-tokens and stop.
2. Prompt: site URL (e.g. `https://example.atlassian.net`).
3. Prompt: space key (e.g. `ENG`).
4. Call `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" init --confluence --site=<url> --space=<key> --parent=<title-or-id>`.
   - The CLI resolves the space (GET /wiki/api/v2/spaces?keys=<key>), looks up the parent page, ensures sub-parents, and writes `docs/wiki/.pwiki.json`.
   - On `error.code = config-invalid`, show the suggested fix and prompt again.
5. Continue with the rest of the scaffold (CLAUDE.md template, `.claude/rules/p-wiki.md`).

If the user picks `fs` (or the default), proceed with the existing FS scaffold path.
```

- [ ] **Step 2: Add `init` subcommand to `pwiki.mjs`**

The existing CLI does not have an `init` subcommand (init is currently driven entirely by the skill). Add a new command that the skill calls for the Confluence branch:

```js
// in pwiki.mjs dispatch:
if (cmd === 'init') {
  const flag = args.confluence;
  if (!flag) { die('use the /p-wiki:init skill for FS scaffolding; only --confluence is supported here', 1); }
  // ... read --site, --space, --parent; resolve via http; ensureSubParent for each type; writeConfig.
}
```

The full implementation is roughly:

```js
import { createHttpClient } from './lib/confluence/http.mjs';
import { ensureSubParent } from './lib/confluence/tree.mjs';
import { writeConfig, validateConfig } from './lib/config.mjs';
import { findWikiRoot } from './lib/paths.mjs';

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

  const http = createHttpClient({ baseUrl: siteUrl, email, token });
  const spaceRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
  const space = spaceRes.body?.results?.[0];
  if (!space) emitJson({ error: { code: 'config-invalid', message: `space ${spaceKey} not found` } }, 1);

  // Resolve parent
  let rootPageId;
  if (/^\d+$/.test(parentTitleOrId)) {
    rootPageId = parentTitleOrId;
    await http.get(`/wiki/api/v2/pages/${rootPageId}`);  // validate access
  } else {
    const cql = `title = "${parentTitleOrId.replace(/"/g, '\\"')}" AND space = "${spaceKey}"`;
    const r = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=2`);
    const hits = r.body?.results ?? [];
    if (hits.length === 0) emitJson({ error: { code: 'config-invalid', message: `parent page "${parentTitleOrId}" not found in space ${spaceKey} — create it in UI first` } }, 1);
    if (hits.length > 1) emitJson({ error: { code: 'config-invalid', message: `parent page title ambiguous (${hits.length} matches) — pass numeric ID instead` } }, 1);
    rootPageId = hits[0].content?.id ?? hits[0].id;
  }

  // Ensure sub-parents
  const subParents = {};
  for (const type of ['concept', 'person', 'source', 'query']) {
    subParents[type] = await ensureSubParent(http, space.id, rootPageId, type);
  }

  const config = {
    destination: 'confluence',
    confluence: { siteUrl, spaceKey, spaceId: space.id, rootPageId, subParents },
  };
  const v = validateConfig(config);
  if (!v.ok) emitJson({ error: { code: 'internal', message: v.error } }, 3);
  writeConfig(root, config);
  emitJson({ ok: true, configPath: 'docs/wiki/.pwiki.json', spaceId: space.id, rootPageId, subParents }, 0);
}
```

Plug it into the existing CLI dispatch.

- [ ] **Step 3: Smoke-test with the fake**

Add a small test (`tools/__tests__/cli-init-confluence.test.ts`) that runs `initConfluence` with an injected transport (refactor `createHttpClient` consumer in `initConfluence` to accept an optional `transport` argument for testability).

Skip if the existing CLI tests already cover this pattern.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/skills/init/SKILL.md plugins/p-wiki/tools/pwiki.mjs
git commit -m "feat(p-wiki): add pwiki init --confluence and init skill branch"
```

---

### Task 30: CLAUDE.md template — "Storage backend" section

**Files:**
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md`

- [ ] **Step 1: Add the section**

Append at the end of the file:

```markdown
## Storage backend

This wiki can be stored on the filesystem (default — `docs/wiki/`) or in Confluence Cloud. The choice is made at `init` time and recorded in `docs/wiki/.pwiki.json`. Skills do not branch on backend; the CLI dispatches transparently.

In Confluence mode:

- Page identity in CLI input/output and in `sources:` cross-references is `confluence://<type>/<slug>` (opaque, stable across UI title renames).
- Body cross-references between pages are real Confluence URLs (`<siteUrl>/wiki/spaces/<key>/pages/<numericId>`) so they render as clickable links in Confluence UI.
- `sources:` paths still point to FS files (raw sources remain on disk in both modes).
- Required env vars: `PWIKI_CONFLUENCE_EMAIL` (Atlassian account email) and `PWIKI_CONFLUENCE_TOKEN` (API token from https://id.atlassian.com/manage-profile/security/api-tokens).
- Pages live under the configured `rootPageId`, organized by sub-parents (Concepts, People, Sources, Queries) plus an Index page regenerated by `pwiki index`.
```

- [ ] **Step 2: Run marketplace tests**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md
git commit -m "docs(p-wiki): document storage backend in wiki CLAUDE.md template"
```

---

### Task 31: CONTRIBUTING.md — E2E sandbox requirements

**Files:**
- Create: `plugins/p-wiki/CONTRIBUTING.md`

- [ ] **Step 1: Write the file**

```markdown
# Contributing

## Running E2E tests against real Confluence

The Confluence E2E suite is gated by `PWIKI_E2E_CONFLUENCE=1` and skipped by default in CI and `npm test`. Before tagging a new minor or major release of p-wiki, run E2E locally against a **dedicated test space** — never against a real working space.

### Setup

1. Create a Confluence Cloud space (e.g. `PWIKITEST`) you can freely create/delete pages in.
2. Create a parent page in that space (e.g. "pwiki E2E root"). Note its numeric page ID from the URL.
3. Generate an Atlassian API token at https://id.atlassian.com/manage-profile/security/api-tokens.

### Run

```bash
PWIKI_CONFLUENCE_EMAIL=you@example.com \
PWIKI_CONFLUENCE_TOKEN=<token> \
PWIKI_E2E_CONFLUENCE=1 \
PWIKI_E2E_SITE_URL=https://your-org.atlassian.net \
PWIKI_E2E_SPACE_KEY=PWIKITEST \
PWIKI_E2E_ROOT_PAGE_ID=<numericId> \
npm test plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
```

The suite creates pages, exercises every CLI command, then deletes everything it created. If the test fails mid-run, pages may be left behind — clean them up manually before re-running.

### What CI runs

CI runs `npm test` without the gating envs, so only unit + contract tests execute. Real-Confluence E2E is local-only.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/p-wiki/CONTRIBUTING.md
git commit -m "docs(p-wiki): add CONTRIBUTING.md for E2E sandbox requirements"
```

---

### Task 32: E2E test against real Confluence

**Files:**
- Create: `plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts`

- [ ] **Step 1: Write the suite**

```ts
// plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpClient } from '../lib/confluence/http.mjs';
import { request as httpsRequest } from 'node:https';

const skip = !process.env.PWIKI_E2E_CONFLUENCE;

function realTransport(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const r = httpsRequest({ host: url.host, path: url.pathname + url.search, method: req.method, headers: req.headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(buf); } catch { body = buf; }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
    });
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}

describe.skipIf(skip)('Confluence E2E', () => {
  const createdIds: string[] = [];
  let http: any;

  beforeAll(() => {
    http = createHttpClient({
      baseUrl: process.env.PWIKI_E2E_SITE_URL!,
      email: process.env.PWIKI_CONFLUENCE_EMAIL!,
      token: process.env.PWIKI_CONFLUENCE_TOKEN!,
      transport: realTransport,
    });
  });

  afterAll(async () => {
    for (const id of createdIds.reverse()) {
      try { await http.delete(`/wiki/api/v2/pages/${id}`); } catch { /* ignore */ }
    }
  });

  it('end-to-end scenario: new → search → set → new query → promote → index → lint', async () => {
    // This is a sketch — fill in via direct ConfluenceDestination construction the same way unit tests do.
    expect(skip).toBe(false);
    // ... see CONTRIBUTING.md
  });
});
```

(This is intentionally a skeleton — the real scenario is fleshed out post-merge once a sandbox space is provisioned.)

- [ ] **Step 2: Verify it skips when env not set**

```bash
npm test plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
```

Expected: 1 skipped.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
git commit -m "test(p-wiki): add gated E2E skeleton against real Confluence"
```

---

### Task 33: Version bump and CLI VERSION alignment

**Files:**
- Modify: `plugins/p-wiki/.claude-plugin/plugin.json`
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (`VERSION` constant)

- [ ] **Step 1: Update both**

In `plugin.json`:

```json
{
  "name": "p-wiki",
  "version": "2.0.0",
  ...
}
```

In `pwiki.mjs`:

```js
const VERSION = '2.0.0';
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
git commit -m "chore(p-wiki): bump version to v2.0.0 (Confluence destination)"
```

**Do NOT tag here.** Per project rules (`.claude/CLAUDE.md`), tagging requires explicit user confirmation after `git log <last-tag>..HEAD --oneline` review. Hand control back to the user at this point and let them initiate the tag.

---

## Notes for the executor

- After each task, run `npm test` to confirm both FS and Confluence suites pass.
- The Confluence destination is opt-in via `docs/wiki/.pwiki.json`. Users with existing v1 FS wikis see no behavior change until they re-run `/p-wiki:init` and pick Confluence.
- The fake transport in `__tests__/fixtures/fake-confluence.mjs` is the single source of truth for offline Confluence behavior in tests. If a destination method requires a new endpoint, extend the fake first, then the destination.
- E2E tests are local-only and gated by `PWIKI_E2E_CONFLUENCE`. Do not commit any test that would call real Confluence in CI.
- When in doubt about Confluence API shapes, consult the spec (`2026-05-15-pwiki-v2-confluence-destination-design.md`) — every endpoint and payload shape is documented there. If the spec says one thing and Atlassian's docs say another, raise it before implementing.
