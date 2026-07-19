# p-observe TUI detail-pane enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show meaningful per-entity metadata in the four pobserve TUI detail panes — job prompt/model, task title/description, wiki frontmatter+links, and the full p-graph status line.

**Architecture:** Each adapter's `status()` snapshot becomes the source of truth for detail metadata (not event `data`). p-shed reads `.pshed/jobs.yml`, p-tasks captures title/description, p-wiki parses `docs/wiki/index.json`, and p-graph already carries every field (render-only). The renderers in `lib/tui/layout/plugins.mjs` read the enriched snapshot for the selected entity.

**Tech Stack:** Node built-ins + ANSI only (zero runtime deps), `.mjs` modules, vitest tests under `tools/__tests__/`.

## Global Constraints

- **Zero runtime deps.** Nothing under `tools/` may `import` a bare package. Node built-ins + ANSI only. No importing p-shed's vendored js-yaml — parse YAML with tolerant hand-written scanners.
- **Never modify observed plugins.** Only read `.pshed/`, `docs/tasks/`, `.pgraph/`, `docs/wiki/`. p-graph stays on `pgraph status --json` — no new CLI commands.
- **Torn-read rule.** Every parse-on-change read catches errors, keeps the prior snapshot as baseline, and retries next tick. Observed plugins write non-atomically.
- **Status snapshot keys** (from `collectStatus`, `core.mjs:34`) are the adapter registration names: `status.pshed`, `status.ptasks`, `status.pgraph`, `status.wiki`.
- Detail-pane layout is unchanged: new fields are `fit()`-truncated to the detail width.
- Run tests from `plugins/p-observe/tools/` with `npx vitest run <file>`.

---

### Task 1: Shared tolerant scalar extractor

Both the p-shed and p-tasks scanners need to read a scalar YAML field, including `js-yaml.dump` block scalars (`prompt: |-` / `description: >-`) where the value is on the following indented line, not inline.

**Files:**
- Create: `plugins/p-observe/tools/lib/adapters/scalars.mjs`
- Test: `plugins/p-observe/tools/__tests__/scalars.test.ts`

**Interfaces:**
- Produces:
  - `unquote(s: string): string` — strips one matching pair of surrounding `'`/`"`.
  - `scalarValue(lines: string[], i: number): string` — value of the `key:` declared on `lines[i]`. Inline value when present and not a block indicator; otherwise the first non-empty following line, trimmed. Never throws; returns `''` on anything unexpected.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { scalarValue, unquote } from '../lib/adapters/scalars.mjs';

describe('unquote', () => {
  it('strips matching surrounding quotes only', () => {
    expect(unquote(`'hi'`)).toBe('hi');
    expect(unquote(`"hi"`)).toBe('hi');
    expect(unquote(`hi`)).toBe('hi');
    expect(unquote(`'mismatched"`)).toBe(`'mismatched"`);
  });
});

describe('scalarValue', () => {
  it('returns an inline value', () => {
    const lines = ['    model: sonnet'];
    expect(scalarValue(lines, 0)).toBe('sonnet');
  });
  it('unquotes an inline value', () => {
    const lines = [`    schedule: '0 9 * * *'`];
    expect(scalarValue(lines, 0)).toBe('0 9 * * *');
  });
  it('reads the first content line of a block scalar', () => {
    const lines = ['    prompt: |-', '      do the thing', '      then stop'];
    expect(scalarValue(lines, 0)).toBe('do the thing');
  });
  it('handles folded and keep/strip indicators', () => {
    expect(scalarValue(['    p: >2', '      folded text'], 0)).toBe('folded text');
    expect(scalarValue(['    p: |+', '      kept'], 0)).toBe('kept');
  });
  it('returns empty string when there is no value and no following line', () => {
    expect(scalarValue(['    p: |-'], 0)).toBe('');
    expect(scalarValue(['    nope'], 0)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/scalars.test.ts`
Expected: FAIL — cannot resolve `../lib/adapters/scalars.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/adapters/scalars.mjs
// Tolerant scalar reader for js-yaml.dump output. Zero-dep; never throws.

const BLOCK_INDICATOR = /^[|>][+-]?\d*$/; // |, |-, |+, >, >2, |-… (block/folded scalar)

export function unquote(s) {
  const t = String(s);
  if (t.length >= 2 && ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// Value of the `key:` declared on lines[i]. Inline when present and not a block
// indicator; otherwise the first non-empty following line, trimmed.
export function scalarValue(lines, i) {
  const line = lines[i] ?? '';
  const m = /:\s*(.*)$/.exec(line);
  if (!m) return '';
  const inline = m[1].trim();
  if (inline && !BLOCK_INDICATOR.test(inline)) return unquote(inline);
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    return lines[j].trim();
  }
  return '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/scalars.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/scalars.mjs plugins/p-observe/tools/__tests__/scalars.test.ts
git commit -m "feat(p-observe): tolerant scalar extractor for YAML detail fields"
```

---

### Task 2: p-shed adapter — jobsMeta from jobs.yml

Read `.pshed/jobs.yml` in `status()` and expose per-job `prompt`/`model`/`schedule`/`enabled`/`timeoutSec`, with a torn-read cache.

**Files:**
- Modify: `plugins/p-observe/tools/lib/adapters/pshed.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-pshed.test.ts`

**Interfaces:**
- Consumes: `scalarValue`, `unquote` from `./scalars.mjs`; `paths.pshedJobs` (already in `config.mjs`).
- Produces:
  - `readJobsMeta(text: string): Record<string, { id, prompt, model, schedule, enabled, timeoutSec }>` (exported).
  - `status()` now also returns `jobsMeta` (same shape) alongside `{ running, jobs }`.

- [ ] **Step 1: Write the failing test** (append to `adapter-pshed.test.ts`)

First extend the existing top-of-file import to add `readJobsMeta`:

```ts
import { createPshedAdapter, readJobsMeta } from '../lib/adapters/pshed.mjs';
```

Then append the new cases:

```ts
const JOBS = `jobs:
  - id: daily
    schedule: '0 9 * * *'
    enabled: true
    prompt: |-
      run the daily digest
      and post it
    model: sonnet
  - id: sync
    schedule: '*/5 * * * *'
    enabled: false
    prompt: sync mirrors
`;

describe('readJobsMeta', () => {
  it('extracts scalar fields and the first prompt line per job', () => {
    const m = readJobsMeta(JOBS);
    expect(m.daily).toMatchObject({ model: 'sonnet', schedule: '0 9 * * *', enabled: 'true', prompt: 'run the daily digest' });
    expect(m.sync).toMatchObject({ model: '', prompt: 'sync mirrors', enabled: 'false' });
  });
});

describe('pshed adapter jobsMeta', () => {
  it('status() exposes jobsMeta parsed from jobs.yml', () => {
    const { p, adapter } = setup();
    mkdirSync(p.pshedDir, { recursive: true });
    writeFileSync(p.pshedJobs, JOBS);
    expect(adapter.status().jobsMeta.daily.model).toBe('sonnet');
  });

  it('keeps the last good jobsMeta on a torn (no trailing newline) write', () => {
    const { p, adapter } = setup();
    mkdirSync(p.pshedDir, { recursive: true });
    writeFileSync(p.pshedJobs, JOBS);
    expect(adapter.status().jobsMeta.daily.model).toBe('sonnet'); // caches good parse
    writeFileSync(p.pshedJobs, 'jobs:\n  - id: daily\n    prompt: |'); // torn, no newline
    expect(adapter.status().jobsMeta.daily.model).toBe('sonnet'); // cached, not clobbered
  });

  it('returns an empty jobsMeta when jobs.yml is absent', () => {
    const { adapter } = setup();
    expect(adapter.status().jobsMeta).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/adapter-pshed.test.ts`
Expected: FAIL — `readJobsMeta` is not exported / `jobsMeta` is undefined.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `pshed.mjs`:

```js
import { scalarValue, unquote } from './scalars.mjs';
```

Add the exported parser (top-level, near `readLines`):

```js
export function readJobsMeta(text) {
  const lines = text.split('\n');
  const jobs = {};
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const dash = /^\s*-\s+id:\s*(.*)$/.exec(lines[i]);
    if (dash) {
      const id = unquote(dash[1].trim());
      cur = { id, prompt: '', model: '', schedule: '', enabled: '', timeoutSec: '' };
      jobs[id] = cur;
      continue;
    }
    if (!cur) continue;
    const kv = /^\s+([A-Za-z][A-Za-z0-9_-]*):/.exec(lines[i]);
    if (kv && kv[1] !== 'id' && kv[1] in cur) cur[kv[1]] = scalarValue(lines, i);
  }
  return jobs;
}
```

Add a closure cache and enrich `status()`. Inside `createPshedAdapter`, add near the other `let` decls:

```js
  let lastJobsMeta = {};
```

Add a helper and extend the returned `status()`:

```js
  function jobsMeta() {
    if (!existsSync(paths.pshedJobs)) return {};
    let text;
    try { text = readFileSync(paths.pshedJobs, 'utf-8'); } catch { return lastJobsMeta; }
    if (!text.endsWith('\n')) return lastJobsMeta; // torn write — keep last good
    lastJobsMeta = readJobsMeta(text);
    return lastJobsMeta;
  }
```

In the `status()` return object, add `jobsMeta: jobsMeta()`:

```js
    status() {
      const running = existsSync(paths.pshedRunDir)
        ? readdirSync(paths.pshedRunDir).filter((n) => /\.pid$/.test(n)).map((n) => n.replace(/\.pid$/, ''))
        : [];
      const jobs = {};
      if (existsSync(paths.pshedStateDir)) {
        for (const name of readdirSync(paths.pshedStateDir)) {
          const m = /^(.+)\.json$/.exec(name); if (!m) continue;
          try { jobs[m[1]] = { lastExit: JSON.parse(readFileSync(join(paths.pshedStateDir, name), 'utf-8')).lastExit }; } catch { /* skip corrupt */ }
        }
      }
      return { running, jobs, jobsMeta: jobsMeta() };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/adapter-pshed.test.ts`
Expected: PASS (existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/pshed.mjs plugins/p-observe/tools/__tests__/adapter-pshed.test.ts
git commit -m "feat(p-observe): expose per-job prompt/model via pshed status jobsMeta"
```

---

### Task 3: p-shed renderer — prompt/model/schedule in detail pane

**Files:**
- Modify: `plugins/p-observe/tools/lib/tui/layout/plugins.mjs` (`pshedBody`)
- Test: `plugins/p-observe/tools/__tests__/tui-layout.test.ts`

**Interfaces:**
- Consumes: `state.status.pshed.jobsMeta[id]` = `{ prompt, model, schedule, enabled, timeoutSec }`.

- [ ] **Step 1: Write the failing test** (add inside `describe('per-plugin bodies', ...)`)

```ts
it('pshedBody shows prompt, model, and schedule for the selected job', () => {
  const s = initState({ tabs: ['overview', 'p-shed'], width: 60, height: 12 });
  s.tab = 'p-shed';
  s.status = { pshed: {
    running: [], jobs: { daily: { lastExit: 0 } },
    jobsMeta: { daily: { prompt: 'run the digest', model: 'sonnet', schedule: '0 9 * * *', enabled: 'true' } },
  } };
  s.events = [ev({ plugin: 'p-shed', entity: 'daily', summary: 'exit 0' })];
  const out = pshedBody(s, 60, 12, { color: false }).join('\n');
  expect(out).toContain('run the digest');
  expect(out).toContain('sonnet');
  expect(out).toContain('0 9 * * *');
});

it('pshedBody marks an unset model as inheriting the default', () => {
  const s = initState({ tabs: ['overview', 'p-shed'], width: 60, height: 12 });
  s.tab = 'p-shed';
  s.status = { pshed: {
    running: [], jobs: { sync: { lastExit: 0 } },
    jobsMeta: { sync: { prompt: 'sync', model: '', schedule: '*/5 * * * *', enabled: 'false' } },
  } };
  s.events = [ev({ plugin: 'p-shed', entity: 'sync', summary: 'exit 0' })];
  const out = pshedBody(s, 60, 12, { color: false }).join('\n');
  expect(out).toContain('inherits default');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: FAIL — output lacks the prompt/model lines.

- [ ] **Step 3: Write minimal implementation**

Replace the detail-building block in `pshedBody`:

```js
  const detail = [];
  if (chosen) {
    const meta = state.status.pshed?.jobsMeta?.[chosen.id] ?? {};
    detail.push(fit(`job: ${chosen.id}`, width));
    detail.push(fit(`state: ${chosen.running ? 'running' : chosen.lastExit != null ? 'exit ' + chosen.lastExit : '—'}`, width));
    if (meta.model || meta.model === '') detail.push(fit(`model: ${meta.model || '(inherits default)'}`, width));
    if (meta.schedule) detail.push(fit(`schedule: ${meta.schedule}`, width));
    if (meta.enabled) detail.push(fit(`enabled: ${meta.enabled}`, width));
    if (meta.prompt) detail.push(fit(`prompt: ${meta.prompt}`, width));
    detail.push('');
    for (const e of eventsFor(state.events, 'p-shed').filter((e) => e.entity === chosen.id))
      detail.push(formatLine(e, { color }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/plugins.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): render job prompt/model/schedule in the p-shed detail pane"
```

---

### Task 4: p-tasks adapter — capture title + description

Generalize `readTaskStates` into `readTasks` (adds title/description), change `baseline` to hold the richer record, and expose a per-task map from `status()`.

**Files:**
- Modify: `plugins/p-observe/tools/lib/adapters/ptasks.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts`

**Interfaces:**
- Consumes: `scalarValue`, `unquote` from `./scalars.mjs`.
- Produces:
  - `readTasks(text: string): Map<string, { status, title, description }>` (exported).
  - `readTaskStates(text)` retained, now derived from `readTasks` (returns `Map<id, status>`).
  - `status()` now also returns `tasks: Record<id, { status, title, description }>` alongside `counts`.

- [ ] **Step 1: Write the failing test** (append to `adapter-ptasks.test.ts`)

First extend the existing top-of-file import (currently `{ createPtasksAdapter, readTaskStates }`) to add `readTasks`:

```ts
import { createPtasksAdapter, readTaskStates, readTasks } from '../lib/adapters/ptasks.mjs';
```

Then append the new cases:

```ts
const TASKS_FULL = `version: 1
tasks:
  - id: TASK-1
    title: Add login
    description: |-
      Wire the OAuth flow
      end to end
    status: todo
`;

describe('readTasks', () => {
  it('captures status, title, and the first description line', () => {
    const m = readTasks(TASKS_FULL);
    expect(m.get('TASK-1')).toMatchObject({ status: 'todo', title: 'Add login', description: 'Wire the OAuth flow' });
  });
  it('readTaskStates stays back-compatible (id -> status)', () => {
    expect(readTaskStates(TASKS_FULL).get('TASK-1')).toBe('todo');
  });
});

describe('ptasks adapter tasks snapshot', () => {
  it('status() exposes title/description per task', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS_FULL);
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: () => {} });
    a.backfill();
    expect(a.status().tasks['TASK-1']).toMatchObject({ title: 'Add login', description: 'Wire the OAuth flow', status: 'todo' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/adapter-ptasks.test.ts`
Expected: FAIL — `readTasks` not exported / `status().tasks` undefined.

- [ ] **Step 3: Write minimal implementation**

Replace the top of `ptasks.mjs` (keep the file header intent). Add the import:

```js
import { scalarValue, unquote } from './scalars.mjs';
```

Replace `readTaskStates` with a `readTasks` scanner + a thin `readTaskStates` wrapper:

```js
// Tolerant per-item scanner over js-yaml.dump output. Never throws.
// Item boundary is the `- id:` dash line; fields are captured within the item.
export function readTasks(text) {
  const lines = text.split('\n');
  const map = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const dash = /^\s*-\s+id:\s*(.*)$/.exec(lines[i]);
    if (dash) {
      cur = { status: '?', title: '', description: '' };
      map.set(unquote(dash[1].trim()), cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^\s+(status|title|description):/.exec(lines[i]);
    if (kv) cur[kv[1]] = scalarValue(lines, i);
  }
  return map;
}

export function readTaskStates(text) {
  const out = new Map();
  for (const [id, t] of readTasks(text)) out.set(id, t.status);
  return out;
}
```

Change the adapter to keep the richer baseline. Replace `readNow`'s success branch and the diff to key on `status`:

```js
  function readNow() {
    const raw = safeRead(paths.tasksFile, (s) => s);
    if (!raw.ok) return { ok: false };
    const text = raw.value;
    if (text.length === 0 || !text.endsWith('\n')) return { ok: false };
    return { ok: true, value: readTasks(text) }; // Map<id, {status,title,description}>
  }

  function diffNow() {
    const r = readNow();
    if (!r.ok) return;
    const next = r.value;
    for (const [id, t] of next) {
      if (!baseline.has(id)) emit(makeEvent('p-tasks', 'task.added', id, `added (${t.status})`, { status: t.status }));
      else if (baseline.get(id).status !== t.status) emit(makeEvent('p-tasks', 'task.status', id, `${baseline.get(id).status} → ${t.status}`, { from: baseline.get(id).status, to: t.status }));
    }
    for (const id of baseline.keys()) if (!next.has(id)) emit(makeEvent('p-tasks', 'task.removed', id, 'removed', {}));
    baseline = next;
  }
```

Update `status()` to emit counts from the record and expose the map:

```js
    status() {
      const counts = {};
      const tasks = {};
      for (const [id, t] of baseline) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
        tasks[id] = { status: t.status, title: t.title, description: t.description };
      }
      return { counts, tasks };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/adapter-ptasks.test.ts`
Expected: PASS — new cases plus all existing diff/torn-read tests (they now compare `.status`).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/ptasks.mjs plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts
git commit -m "feat(p-observe): capture task title/description in ptasks snapshot"
```

---

### Task 5: p-tasks renderer — title + description in detail pane

**Files:**
- Modify: `plugins/p-observe/tools/lib/tui/layout/plugins.mjs` (`ptasksBody`)
- Test: `plugins/p-observe/tools/__tests__/tui-layout.test.ts`

**Interfaces:**
- Consumes: `state.status.ptasks.tasks[id]` = `{ status, title, description }`.

Note: the task list is derived from events (`tasksList`), so the test seeds a `task.added` event so the task appears in the master list, and puts title/description in `status.ptasks.tasks`.

- [ ] **Step 1: Write the failing test** (add inside `describe('per-plugin bodies', ...)`; import `ptasksBody`)

Update the import line at the top of the test file:

```ts
import { pshedBody, pgraphBody, ptasksBody, pwikiBody } from '../lib/tui/layout/plugins.mjs';
```

Add the test:

```ts
it('ptasksBody shows the title and description of the selected task', () => {
  const s = initState({ tabs: ['overview', 'p-tasks'], width: 60, height: 12 });
  s.tab = 'p-tasks';
  s.events = [ev({ plugin: 'p-tasks', kind: 'task.added', entity: 'TASK-1', summary: 'added (todo)', data: { status: 'todo' } })];
  s.status = { ptasks: { counts: { todo: 1 }, tasks: { 'TASK-1': { status: 'todo', title: 'Add login', description: 'Wire the OAuth flow' } } } };
  const out = ptasksBody(s, 60, 12, { color: false }).join('\n');
  expect(out).toContain('Add login');
  expect(out).toContain('Wire the OAuth flow');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: FAIL — title/description not rendered.

- [ ] **Step 3: Write minimal implementation**

Replace the detail block in `ptasksBody`:

```js
  const detail = [];
  if (chosen) {
    const meta = state.status.ptasks?.tasks?.[chosen.id] ?? {};
    detail.push(fit(`task: ${chosen.id}  [${chosen.status}]`, width));
    if (meta.title) detail.push(fit(meta.title, width));
    if (meta.description) {
      const words = meta.description.split(/\s+/);
      let line = '';
      let wrapped = 0;
      for (const w of words) {
        if ((line + ' ' + w).trim().length > width) { detail.push(fit(line, width)); line = w; if (++wrapped >= 4) break; }
        else line = (line + ' ' + w).trim();
      }
      if (line && wrapped < 4) detail.push(fit(line, width));
    }
    detail.push('');
    for (const h of chosen.history) detail.push(fit(`  ${h.summary}`, width));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/plugins.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): render task title/description in the p-tasks detail pane"
```

---

### Task 6: p-wiki adapter — pagesMeta from index.json

Parse `docs/wiki/index.json` into a per-page metadata map (frontmatter facts, summary, outlinks, backlinks, orphan), cached and refreshed on index change, with a torn-read gate.

**Files:**
- Modify: `plugins/p-observe/tools/lib/adapters/pwiki.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts`

**Interfaces:**
- Consumes: `paths.wikiIndexJson`; `basename` (already imported).
- Produces:
  - `derivePagesMeta(pages: Array<{type,id,path,frontmatter,body}>): Record<basename, { title, type, tags, source, compiled, conflictSince, summary, outlinks: string[], backlinks: string[], orphan: boolean }>` (exported).
  - `status()` now also returns `pagesMeta` alongside `{ pages, raw, conflicts }`.

- [ ] **Step 1: Write the failing test** (append to `adapter-pwiki.test.ts`)

First extend the existing top-of-file import (currently `{ createPwikiAdapter, readFrontmatter }`) to add `derivePagesMeta`:

```ts
import { createPwikiAdapter, readFrontmatter, derivePagesMeta } from '../lib/adapters/pwiki.mjs';
```

Then append the new cases (note: the existing `mk()` helper is scoped to another `describe`, so the adapter test builds its own setup inline):

```ts
const bundle = (pages: any[]) => JSON.stringify({ schema: 1, pages }, null, 2) + '\n';

describe('derivePagesMeta', () => {
  const pages = [
    { type: 'concept', id: 'auth', path: 'pages/concept/auth.md',
      frontmatter: { title: 'Auth', type: 'concept', tags: ['security'], id: 'auth' },
      body: '# Auth\n\nHow login works. See [[session]].\n' },
    { type: 'concept', id: 'session', path: 'pages/concept/session.md',
      frontmatter: { title: 'Session', id: 'session' },
      body: 'Session details.\n' },
    { type: 'note', id: 'lonely', path: 'pages/lonely.md',
      frontmatter: { title: 'Lonely', id: 'lonely' }, body: 'Nothing links here or out.\n' },
  ];
  it('derives frontmatter, summary, links, backlinks and orphan flag', () => {
    const m = derivePagesMeta(pages);
    expect(m['auth.md']).toMatchObject({ title: 'Auth', type: 'concept', summary: 'How login works. See [[session]].' });
    expect(m['auth.md'].outlinks).toContain('session.md');
    expect(m['session.md'].backlinks).toContain('auth.md');
    expect(m['session.md'].orphan).toBe(false);
    expect(m['lonely.md'].orphan).toBe(true);
  });
});

describe('pwiki adapter pagesMeta', () => {
  it('status() parses index.json into pagesMeta and caches it on a torn write', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.wikiPagesDir, { recursive: true });
    const a = createPwikiAdapter({ root, paths: p, cfg, emit: () => {} });
    writeFileSync(p.wikiIndexJson, bundle([
      { type: 'concept', id: 'auth', path: 'pages/auth.md', frontmatter: { title: 'Auth', id: 'auth' }, body: 'x\n' },
    ]));
    a.backfill();
    expect(a.status().pagesMeta['auth.md'].title).toBe('Auth');
    writeFileSync(p.wikiIndexJson, '{ "pages": ['); // torn, no trailing newline
    a.backfill(); // refreshIndex hits the torn gate deterministically; cache kept
    expect(a.status().pagesMeta['auth.md'].title).toBe('Auth'); // cached, not clobbered
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/adapter-pwiki.test.ts`
Expected: FAIL — `derivePagesMeta` not exported / `pagesMeta` undefined.

- [ ] **Step 3: Write minimal implementation**

Add the exported deriver (top-level in `pwiki.mjs`):

```js
function firstParagraph(body) {
  const out = [];
  for (const l of (body ?? '').split('\n')) {
    const t = l.trim();
    if (t === '' || /^#{1,6}\s/.test(t)) { if (out.length) break; else continue; }
    out.push(t);
  }
  return out.join(' ');
}

function outlinkTargets(body) {
  const ids = new Set(), files = new Set();
  let m;
  const wl = /\[\[([^\]|#]+)/g;
  while ((m = wl.exec(body ?? ''))) ids.add(m[1].trim());
  const md = /\]\(([^)\s]+\.md)[^)]*\)/g;
  while ((m = md.exec(body ?? ''))) files.add(basename(m[1].trim()));
  return { ids, files };
}

export function derivePagesMeta(pages) {
  const meta = {};
  const byId = {};
  for (const pg of pages) {
    const key = basename(pg.path);
    const fm = pg.frontmatter ?? {};
    meta[key] = {
      title: fm.title ?? '', type: fm.type ?? '',
      tags: Array.isArray(fm.tags) ? fm.tags.join(', ') : (fm.tags ?? ''),
      source: fm.source ?? '', compiled: fm.compiled ?? '', conflictSince: fm['conflict-since'] ?? '',
      summary: firstParagraph(pg.body), outlinks: [], backlinks: [], orphan: false,
    };
    if (fm.id) byId[fm.id] = key;
  }
  for (const pg of pages) {
    const key = basename(pg.path);
    const { ids, files } = outlinkTargets(pg.body);
    const resolved = new Set();
    const dangling = [];
    for (const id of ids) { if (byId[id]) resolved.add(byId[id]); else dangling.push(id); }
    for (const f of files) { if (meta[f]) resolved.add(f); else dangling.push(f); }
    meta[key].outlinks = [...resolved, ...dangling];
    for (const t of resolved) if (t !== key) meta[t].backlinks.push(key);
  }
  for (const key of Object.keys(meta)) {
    meta[key].orphan = meta[key].outlinks.length === 0 && meta[key].backlinks.length === 0;
  }
  return meta;
}
```

Add a closure cache + refresh. Inside `createPwikiAdapter`, next to the other `let`s:

```js
  let pagesMeta = {};
```

Add the refresh function and call it wherever the index is (re)observed:

```js
  function refreshIndex() {
    const r = safeRead(paths.wikiIndexJson, (s) => s);
    if (!r.ok) return;                       // missing/unreadable -> keep prior
    if (!r.value.endsWith('\n')) return;     // torn write (bundle ends with \n) -> keep prior
    let bundle;
    try { bundle = JSON.parse(r.value); } catch { return; } // invalid -> keep prior
    if (bundle && Array.isArray(bundle.pages)) pagesMeta = derivePagesMeta(bundle.pages);
  }
```

Call `refreshIndex()` from `checkReindex()` (on seed and on change) and from `backfill()`:

```js
  function checkReindex() {
    const m = indexMtime();
    if (m === null) return;
    if (lastIndexMtime === null) { lastIndexMtime = m; refreshIndex(); return; }
    if (m !== lastIndexMtime) { lastIndexMtime = m; refreshIndex(); emit(makeEvent('p-wiki', 'wiki.reindex', 'index.json', 'index regenerated', {})); }
  }
```

```js
    backfill() { snap = scan(); lastIndexMtime = indexMtime(); refreshIndex(); },
```

Extend `status()`:

```js
    status() {
      let pages = 0, raw = 0, conflicts = 0;
      for (const meta of snap.values()) { if (meta.raw) raw++; else { pages++; if (meta.conflict) conflicts++; } }
      return { pages, raw, conflicts, pagesMeta };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/adapter-pwiki.test.ts`
Expected: PASS — new cases plus existing conflict/reindex tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/pwiki.mjs plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts
git commit -m "feat(p-observe): derive wiki page metadata and link graph from index.json"
```

---

### Task 7: p-wiki renderer — frontmatter, summary, links in detail pane

**Files:**
- Modify: `plugins/p-observe/tools/lib/tui/layout/plugins.mjs` (`pwikiBody`)
- Test: `plugins/p-observe/tools/__tests__/tui-layout.test.ts`

**Interfaces:**
- Consumes: `state.status.wiki.pagesMeta[basename]` (registration key is `wiki`, per `core.mjs`).

The master list is derived from events (`pagesList`, entity = `basename(f)`), so the test seeds a `page.compiled` event so the page appears in the list.

- [ ] **Step 1: Write the failing test** (add inside `describe('per-plugin bodies', ...)`)

```ts
it('pwikiBody shows frontmatter, summary and backlinks for the selected page', () => {
  const s = initState({ tabs: ['overview', 'p-wiki'], width: 70, height: 14 });
  s.tab = 'p-wiki';
  s.events = [ev({ plugin: 'p-wiki', kind: 'page.compiled', entity: 'auth.md', summary: 'compiled' })];
  s.status = { wiki: { pages: 1, raw: 0, conflicts: 0, pagesMeta: {
    'auth.md': { title: 'Auth', type: 'concept', tags: 'security', source: '', compiled: 'true', conflictSince: '',
      summary: 'How login works.', outlinks: ['session.md'], backlinks: ['index.md'], orphan: false },
  } } };
  const out = pwikiBody(s, 70, 14, { color: false }).join('\n');
  expect(out).toContain('Auth');
  expect(out).toContain('How login works.');
  expect(out).toContain('session.md');   // outlink
  expect(out).toContain('index.md');      // backlink
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: FAIL — metadata not rendered.

- [ ] **Step 3: Write minimal implementation**

Replace the detail block in `pwikiBody`:

```js
  const detail = [];
  if (chosen) {
    const meta = state.status.wiki?.pagesMeta?.[chosen.id] ?? {};
    detail.push(fit(`page: ${chosen.id}${chosen.conflict ? '  ⚠ conflict' : ''}${meta.orphan ? '  · orphan' : ''}`, width));
    if (meta.title) detail.push(fit(`title: ${meta.title}`, width));
    if (meta.type) detail.push(fit(`type: ${meta.type}`, width));
    if (meta.tags) detail.push(fit(`tags: ${meta.tags}`, width));
    if (meta.source) detail.push(fit(`source: ${meta.source}`, width));
    if (meta.compiled !== '' && meta.compiled != null) detail.push(fit(`compiled: ${meta.compiled}`, width));
    if (meta.conflictSince) detail.push(fit(`conflict-since: ${meta.conflictSince}`, width));
    if (meta.summary) { detail.push(''); detail.push(fit(meta.summary, width)); }
    if (meta.outlinks?.length) detail.push(fit(`→ ${meta.outlinks.join(', ')}`, width));
    if (meta.backlinks?.length) detail.push(fit(`← ${meta.backlinks.join(', ')}`, width));
    detail.push('');
    for (const e of eventsFor(state.events, 'p-wiki').filter((e) => e.entity === chosen.id))
      detail.push(formatLine(e, { color }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/plugins.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): render wiki frontmatter, summary and links in the detail pane"
```

---

### Task 8: p-graph renderer — full status header (render-only)

The p-graph adapter already returns every `status --json` field; only the header render needs to surface `schema_version`, a short `indexed_sha`, and `fts`.

**Files:**
- Modify: `plugins/p-observe/tools/lib/tui/layout/plugins.mjs` (`pgraphBody`)
- Test: `plugins/p-observe/tools/__tests__/tui-layout.test.ts`

**Interfaces:**
- Consumes: `state.status.pgraph` = `{ schema_version, indexed_sha, fts, nodes, edges, files, drift }`.

- [ ] **Step 1: Write the failing test** (extend the existing `pgraphBody` test / add a new one)

```ts
it('pgraphBody shows schema, short sha and fts alongside counters', () => {
  const s = initState({ tabs: ['overview', 'p-graph'], width: 70, height: 8 });
  s.tab = 'p-graph';
  s.status = { pgraph: { schema_version: 3, indexed_sha: 'abcdef1234567890', fts: 1, nodes: 120, edges: 300, files: 42, drift: 0 } };
  s.events = [ev({ plugin: 'p-graph', entity: '-', summary: '+3 nodes (120 total)' })];
  const out = pgraphBody(s, 70, 8, { color: false }).join('\n');
  expect(out).toContain('schema 3');
  expect(out).toContain('abcdef1');  // short sha (7 chars)
  expect(out).toContain('fts');
  expect(out).toContain('120');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: FAIL — header lacks schema/sha/fts.

- [ ] **Step 3: Write minimal implementation**

Replace the first pushed line in `pgraphBody`:

```js
  const g = state.status.pgraph ?? {};
  const lines = [];
  const sha = g.indexed_sha ? String(g.indexed_sha).slice(0, 7) : '-';
  const fts = g.fts == null ? '?' : (g.fts ? 'on' : 'off');
  lines.push(fit(`schema ${g.schema_version ?? '?'} · sha ${sha} · fts ${fts}`, width));
  lines.push(fit(`nodes ${g.nodes ?? '?'} · edges ${g.edges ?? '?'} · files ${g.files ?? '?'} · drift ${g.drift ?? '?'}`, width));
  lines.push(fit('─'.repeat(width), width));
  const hist = applyFilterList(graphHistory(state.events), state.filter, (h) => h.summary);
  for (const h of hist.slice(-(height - 3))) lines.push(fit(`  ${h.summary}`, width));
  return lines.slice(0, height);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/tui-layout.test.ts`
Expected: PASS. Confirm the pre-existing `pgraphBody` test (`120`, `nodes`) still passes.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/plugins.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): surface schema/sha/fts in the p-graph header"
```

---

### Task 9: Full suite

- [ ] **Step 1: Run the whole p-observe suite**

Run (from `plugins/p-observe/tools/`): `npx vitest run`
Expected: all test files green, including `tui-layout`, `adapter-*`, `scalars`.

**Do not bump the plugin version or tag a release here.** Versioning/release is a separate step and only happens when explicitly requested. When that request comes, this work is a backwards-compatible feature addition (new detail fields; no removed/renamed skills or commands) → a **minor** bump of `plugins/p-observe/.claude-plugin/plugin.json#version`.

---

## Notes for the implementer

- **Detail panes are narrow** (~40% of width goes to the master list). All new lines pass through `fit()`, so long prompts/titles/summaries are truncated, not wrapped — except the task description, which is deliberately word-wrapped to ≤4 lines.
- **Lists are event-derived.** `tasksList`/`pagesList` build the master list from the event stream, while the new metadata comes from `status()`. An entity only shows in the list once it has at least one event (a diff or journal-replayed event); the metadata simply enriches whatever is shown. This is existing behavior — do not try to populate the list from `status()`.
- **Join keys:** jobs by `id`, tasks by `id`, pages by `basename(path)`. These match how the existing derive functions key their lists.
