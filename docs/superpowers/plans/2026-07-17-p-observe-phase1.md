# p-observe Phase 1 (event core + adapters + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `p-observe` plugin's zero-touch event core — adapters for p-shed/p-tasks/p-graph/p-wiki, a normalized event bus, an optional on-disk journal, and the `pobserve watch` / `status` / `capture` CLIs — so background plugin activity is visible as a live human-readable stream.

**Architecture:** Per-plugin **adapters** derive events by tailing/watching each plugin's state (never modifying it) and `emit` normalized `Event` objects into an in-memory **bus** (ring buffer + pub/sub). **Renderers** (stream, status) and the optional **journal sink** are just subscribers. A thin CLI (`pobserve.mjs`) wires config → adapters → bus → subscribers per command.

**Tech Stack:** Node ≥ 18 ESM (`.mjs`), zero runtime dependencies (`node:fs`, `node:path`, `node:child_process`, `node:os`, ANSI strings only). Tests: vitest (`.test.ts` importing `.mjs`), temp dirs via `mkdtempSync`. Same packaging model as p-shed/p-tasks (plain file copy, no `npm install` at install time).

**Design spec:** `docs/superpowers/specs/2026-07-17-p-observe-design.md` (read it first).

## Global Constraints

- **Node ≥ 18**, **zero external runtime dependencies**. Nothing under `tools/` may `import` a bare package name (vitest in tests is fine — it never ships). No vendoring needed.
- **Zero-touch:** never write to `.pshed/`, `docs/tasks/`, `.pgraph/`, or `docs/wiki/`. p-observe only reads them. p-observe's own writes go only under `.pobserve/`.
- **Never open `graph.db`** (would force Node ≥ 22.5 + schema coupling). The p-graph adapter only ever shells out to `pgraph status --json` via `nodeBin`, and degrades to mtime-only when `pgraphCli` is unset/failing.
- **Torn-read rule:** every parse-on-change adapter catches parse errors, keeps its previous snapshot as the diff baseline, and retries on the next tick — never throws, never advances baseline on a failed parse.
- **No Claude/Anthropic attribution** anywhere in files, commits, or PRs (repo rule).
- **Event shape (canonical):** `{ ts:number, plugin:string, kind:string, entity:string, severity:'ok'|'info'|'warn'|'error', summary:string, data:object }`.
- **Out of scope for this plan:** the TUI (Phase 2), the p-shed log enrichment (separate p-shed release), and cron→next-due computation (Phase 2 panel sugar). Adapters emit only what durable state already gives them.

## File Structure

```
plugins/p-observe/
  .claude-plugin/plugin.json        # manifest (name, version, description, author)
  README.md                          # user docs
  CLAUDE.md                          # contributor guide
  .gitignore-note                    # (root .gitignore already ignores .pobserve/ — added in Task 13)
  tools/
    pobserve.mjs                     # CLI entry: arg parse + command dispatch + core assembly
    lib/
      event.mjs                      # makeEvent(), severityFor()
      bus.mjs                        # createBus(): ring buffer + pub/sub
      config.mjs                     # loadConfig(), detectPlugins(), paths()
      watch.mjs                      # watchPath() debounced watcher, safeRead()
      journal.mjs                    # journal sink: appendJournal(), rotateJournal(), replayJournal()
      adapters/
        pshed.mjs                    # createPshedAdapter()
        ptasks.mjs                   # createPtasksAdapter()
        pgraph.mjs                   # createPgraphAdapter()
        pwiki.mjs                    # createPwikiAdapter()
      render/
        stream.mjs                   # formatLine(event) for `watch`
        status.mjs                   # formatStatus(snapshot) for `status`
    __tests__/                       # vitest specs (one per lib module)
  skills/
    init/SKILL.md
    watch/SKILL.md
    help/SKILL.md
```

**Adapter contract** (every `adapters/*.mjs` exports `create<Name>Adapter({ root, paths, cfg, emit })` returning):
- `backfill()` — emit historical events from durable sources (cold start only). Returns void.
- `start()` — begin live watching; call `emit(event)` on change. Returns void.
- `stop()` — close watchers. Returns void.
- `status()` — return a plain rollup object for `pobserve status`.

`emit` is `bus.push`. The core decides backfill source: replay journal if present, else call each adapter's `backfill()`.

---

### Task 1: Plugin scaffold + CLI entry stub + marketplace registration

**Files:**
- Create: `plugins/p-observe/.claude-plugin/plugin.json`
- Create: `plugins/p-observe/tools/pobserve.mjs`
- Modify: `.claude-plugin/marketplace.json` (add the p-observe entry to `plugins`)
- Test: `plugins/p-observe/tools/__tests__/cli-entry.test.ts`

**Interfaces:**
- Produces: an executable CLI at `tools/pobserve.mjs` that, given `help` or no args, prints usage to stdout and exits 0; unknown command exits 2.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/cli-entry.test.ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pobserve.mjs');
const run = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });

describe('pobserve CLI entry', () => {
  it('prints usage for help', () => {
    expect(run(['help'])).toMatch(/pobserve (watch|status|capture)/);
  });
  it('prints usage with no args', () => {
    expect(run([])).toMatch(/Usage:/);
  });
  it('exits non-zero on unknown command', () => {
    expect(() => run(['bogus'])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/cli-entry.test.ts`
Expected: FAIL (file `pobserve.mjs` does not exist).

- [ ] **Step 3: Create the manifest**

```json
// plugins/p-observe/.claude-plugin/plugin.json
{
  "name": "p-observe",
  "version": "0.1.0",
  "description": "Zero-touch realtime observability for perky.team plugins. Watches p-shed/p-tasks/p-graph/p-wiki runtime state and emits a normalized human-readable event stream. Commands (tool `pobserve`): watch, status, capture. Skills: init, watch, help.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 4: Create the CLI stub**

```js
// plugins/p-observe/tools/pobserve.mjs
const USAGE = `Usage: pobserve <command> [options]

Commands:
  watch     Live merged event stream across observed plugins
  status    One-shot snapshot (counters + running/failed)
  capture   Headless: run the bus + on-disk journal, no UI
  help      Show this help

Options:
  --plugin=<name>    filter to one plugin (watch)
  --severity=<lvl>   filter by min severity (watch)
  --journal          also append events to .pobserve/events.jsonl (watch)
`;

const KNOWN = new Set(['watch', 'status', 'capture', 'help']);

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help') { process.stdout.write(USAGE); return 0; }
  if (!KNOWN.has(command)) { process.stderr.write(`unknown command: ${command}\n`); return 2; }
  // command implementations wired in Task 12.
  process.stdout.write(USAGE);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/cli-entry.test.ts`
Expected: PASS.

- [ ] **Step 6: Register in the marketplace catalog**

Add this object to the `plugins` array in `.claude-plugin/marketplace.json` (after the `p-shed` entry):

```json
    {
      "name": "p-observe",
      "source": "./plugins/p-observe",
      "description": "Zero-touch realtime observability: watches p-shed/p-tasks/p-graph/p-wiki runtime state and emits a normalized human-readable event stream (pobserve watch/status/capture). Skills: init, watch, help."
    }
```

- [ ] **Step 7: Commit**

```bash
git add plugins/p-observe/.claude-plugin/plugin.json plugins/p-observe/tools/pobserve.mjs plugins/p-observe/tools/__tests__/cli-entry.test.ts .claude-plugin/marketplace.json
git commit -m "feat(p-observe): scaffold plugin, CLI entry, marketplace entry"
```

---

### Task 2: Event model (`event.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/event.mjs`
- Test: `plugins/p-observe/tools/__tests__/event.test.ts`

**Interfaces:**
- Produces:
  - `severityFor(kind: string, data: object) → 'ok'|'info'|'warn'|'error'`
  - `makeEvent(plugin, kind, entity, summary, data = {}, ts) → Event` (canonical shape; `severity` auto-derived; `ts` defaults to `Date.now()` when omitted).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/event.test.ts
import { describe, expect, it } from 'vitest';
import { makeEvent, severityFor } from '../lib/event.mjs';

describe('severityFor', () => {
  it('errors on non-zero exit or timeout', () => {
    expect(severityFor('job.finished', { exit: 1 })).toBe('error');
    expect(severityFor('job.finished', { exit: 0, timedOut: true })).toBe('error');
  });
  it('ok on clean job completion', () => {
    expect(severityFor('job.finished', { exit: 0 })).toBe('ok');
  });
  it('warns on drift and conflict', () => {
    expect(severityFor('drift.warn', {})).toBe('warn');
    expect(severityFor('wiki.conflict', {})).toBe('warn');
  });
  it('errors on a failed pgraph refresh', () => {
    expect(severityFor('index.refresh', { error: true })).toBe('error');
  });
  it('info for everything else', () => {
    expect(severityFor('task.status', {})).toBe('info');
    expect(severityFor('job.launched', {})).toBe('info');
  });
});

describe('makeEvent', () => {
  it('builds the canonical shape with derived severity', () => {
    const e = makeEvent('p-shed', 'job.finished', 'daily-index', 'exit 0 (42s)', { exit: 0, durationMs: 42000 }, 1000);
    expect(e).toEqual({
      ts: 1000, plugin: 'p-shed', kind: 'job.finished', entity: 'daily-index',
      severity: 'ok', summary: 'exit 0 (42s)', data: { exit: 0, durationMs: 42000 },
    });
  });
  it('defaults data to {} and severity accordingly', () => {
    const e = makeEvent('p-tasks', 'task.added', 'TASK-9', 'added', undefined, 5);
    expect(e.data).toEqual({});
    expect(e.severity).toBe('info');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/event.test.ts`
Expected: FAIL (`event.mjs` not found).

- [ ] **Step 3: Implement `event.mjs`**

```js
// plugins/p-observe/tools/lib/event.mjs
export function severityFor(kind, data = {}) {
  if (kind === 'job.finished') return (data.timedOut || data.exit !== 0) ? 'error' : 'ok';
  if (kind === 'drift.warn' || kind === 'wiki.conflict') return 'warn';
  if (kind === 'index.refresh' && data.error) return 'error';
  return 'info';
}

export function makeEvent(plugin, kind, entity, summary, data = {}, ts = Date.now()) {
  return { ts, plugin, kind, entity, severity: severityFor(kind, data), summary, data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/event.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/event.mjs plugins/p-observe/tools/__tests__/event.test.ts
git commit -m "feat(p-observe): normalized event model + severity mapping"
```

---

### Task 3: Event bus (`bus.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/bus.mjs`
- Test: `plugins/p-observe/tools/__tests__/bus.test.ts`

**Interfaces:**
- Produces: `createBus({ size = 500 }) → { push(event), subscribe(fn) → unsubscribe, snapshot() → Event[] }`. `push` appends to a bounded ring buffer (evicting oldest past `size`) and synchronously notifies subscribers. `snapshot()` returns a copy of the current buffer.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/bus.test.ts
import { describe, expect, it } from 'vitest';
import { createBus } from '../lib/bus.mjs';

describe('createBus', () => {
  it('delivers pushed events to subscribers', () => {
    const bus = createBus({ size: 10 });
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.ts));
    bus.push({ ts: 1 }); bus.push({ ts: 2 });
    expect(seen).toEqual([1, 2]);
  });
  it('bounds the ring buffer to size, evicting oldest', () => {
    const bus = createBus({ size: 2 });
    bus.push({ ts: 1 }); bus.push({ ts: 2 }); bus.push({ ts: 3 });
    expect(bus.snapshot().map((e) => e.ts)).toEqual([2, 3]);
  });
  it('unsubscribe stops delivery', () => {
    const bus = createBus({ size: 10 });
    const seen: number[] = [];
    const off = bus.subscribe((e) => seen.push(e.ts));
    bus.push({ ts: 1 }); off(); bus.push({ ts: 2 });
    expect(seen).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/bus.test.ts`
Expected: FAIL (`bus.mjs` not found).

- [ ] **Step 3: Implement `bus.mjs`**

```js
// plugins/p-observe/tools/lib/bus.mjs
export function createBus({ size = 500 } = {}) {
  const buf = [];
  const subs = new Set();
  return {
    push(event) {
      buf.push(event);
      if (buf.length > size) buf.shift();
      for (const fn of subs) fn(event);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    snapshot() { return buf.slice(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/bus.mjs plugins/p-observe/tools/__tests__/bus.test.ts
git commit -m "feat(p-observe): event bus (ring buffer + pub/sub)"
```

---

### Task 4: Config + path resolution (`config.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/config.mjs`
- Test: `plugins/p-observe/tools/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(root) → { roots:{pshed,ptasks,pgraph,wiki}, pgraphCli, nodeBin, bufferSize, journal, journalRetentionDays }` — defaults, overlaid by `root/.pobserve.json` if present (a corrupt file is ignored, defaults used).
  - `paths(root, cfg) → { pshedDir, pshedLogsDir, pshedRunDir, tasksFile, graphDb, wikiDir, wikiPagesDir, pwikiConfig, observeDir, journalDir }` — all absolute.
  - `detectPlugins(root, cfg) → { pshed:boolean, ptasks:boolean, pgraph:boolean, wiki:boolean }` — presence by `existsSync` of each root.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/config.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, detectPlugins, paths } from '../lib/config.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-cfg-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('returns defaults with no config file', () => {
    const c = loadConfig(root);
    expect(c.bufferSize).toBe(500);
    expect(c.journal).toBe(false);
    expect(c.journalRetentionDays).toBe(7);
    expect(c.roots.pgraph).toBe('.pgraph/graph.db');
    expect(c.pgraphCli).toBe(null);
  });
  it('overlays .pobserve.json over defaults', () => {
    writeFileSync(join(root, '.pobserve.json'), JSON.stringify({ bufferSize: 50, pgraphCli: '/x/pgraph.mjs' }));
    const c = loadConfig(root);
    expect(c.bufferSize).toBe(50);
    expect(c.pgraphCli).toBe('/x/pgraph.mjs');
    expect(c.journalRetentionDays).toBe(7); // untouched default preserved
  });
  it('ignores a corrupt config file, falling back to defaults', () => {
    writeFileSync(join(root, '.pobserve.json'), '{ not json');
    expect(loadConfig(root).bufferSize).toBe(500);
  });
});

describe('detectPlugins', () => {
  it('detects only plugins whose roots exist', () => {
    mkdirSync(join(root, '.pshed'));
    mkdirSync(join(root, 'docs', 'wiki'), { recursive: true });
    const d = detectPlugins(root, loadConfig(root));
    expect(d).toEqual({ pshed: true, ptasks: false, pgraph: false, wiki: true });
  });
});

describe('paths', () => {
  it('resolves absolute targets', () => {
    const p = paths(root, loadConfig(root));
    expect(p.tasksFile).toBe(join(root, 'docs/tasks/tasks.yml'));
    expect(p.graphDb).toBe(join(root, '.pgraph/graph.db'));
    expect(p.journalDir).toBe(join(root, '.pobserve'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/config.test.ts`
Expected: FAIL (`config.mjs` not found).

- [ ] **Step 3: Implement `config.mjs`**

```js
// plugins/p-observe/tools/lib/config.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

const DEFAULTS = {
  roots: { pshed: '.pshed', ptasks: 'docs/tasks/tasks.yml', pgraph: '.pgraph/graph.db', wiki: 'docs/wiki' },
  pgraphCli: null,
  nodeBin: 'node',
  bufferSize: 500,
  journal: false,
  journalRetentionDays: 7,
};

export function loadConfig(root) {
  const p = join(root, '.pobserve.json');
  if (!existsSync(p)) return { ...DEFAULTS, roots: { ...DEFAULTS.roots } };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return { ...DEFAULTS, ...raw, roots: { ...DEFAULTS.roots, ...(raw.roots ?? {}) } };
  } catch {
    return { ...DEFAULTS, roots: { ...DEFAULTS.roots } };
  }
}

const abs = (root, rel) => (isAbsolute(rel) ? rel : resolve(root, rel));

export function paths(root, cfg) {
  const pshedDir = abs(root, cfg.roots.pshed);
  const wikiDir = abs(root, cfg.roots.wiki);
  const observeDir = join(root, '.pobserve');
  return {
    pshedDir,
    pshedLogsDir: join(pshedDir, 'logs'),
    pshedRunDir: join(pshedDir, 'run'),
    pshedStateDir: join(pshedDir, 'state'),
    pshedJobs: join(pshedDir, 'jobs.yml'),
    tasksFile: abs(root, cfg.roots.ptasks),
    graphDb: abs(root, cfg.roots.pgraph),
    wikiDir,
    wikiPagesDir: join(wikiDir, 'pages'),
    wikiRawDir: join(wikiDir, 'raw'),
    wikiIndexJson: join(wikiDir, 'index.json'),
    pwikiConfig: join(wikiDir, '.pwiki.json'),
    observeDir,
    journalDir: observeDir,
    journalFile: join(observeDir, 'events.jsonl'),
  };
}

export function detectPlugins(root, cfg) {
  const p = paths(root, cfg);
  return {
    pshed: existsSync(p.pshedDir),
    ptasks: existsSync(p.tasksFile),
    pgraph: existsSync(p.graphDb),
    wiki: existsSync(p.wikiDir),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/config.mjs plugins/p-observe/tools/__tests__/config.test.ts
git commit -m "feat(p-observe): config loader, path resolution, plugin auto-detect"
```

---

### Task 5: Watch helper + safe read (`watch.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/watch.mjs`
- Test: `plugins/p-observe/tools/__tests__/watch.test.ts`

**Interfaces:**
- Produces:
  - `safeRead(path, parse) → { ok:true, value } | { ok:false }` — reads+parses; any read/parse throw yields `{ ok:false }` (torn-read rule).
  - `watchPath(target, onChange, { debounceMs = 150 }) → { close() }` — watches `target` (a dir), coalescing bursts into a single debounced `onChange()` call; tolerant of the dir not existing yet (no throw; `onChange` simply never fires until it does — caller pre-creates or the parent is watched). For Phase 1, callers pass a directory that exists (guarded by `detectPlugins`).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/watch.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeRead, watchPath } from '../lib/watch.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-watch-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('safeRead', () => {
  it('returns parsed value on success', () => {
    const f = join(root, 'a.json'); writeFileSync(f, '{"x":1}');
    expect(safeRead(f, JSON.parse)).toEqual({ ok: true, value: { x: 1 } });
  });
  it('returns {ok:false} on a missing file', () => {
    expect(safeRead(join(root, 'nope'), JSON.parse)).toEqual({ ok: false });
  });
  it('returns {ok:false} on a parse throw (torn read)', () => {
    const f = join(root, 'b.json'); writeFileSync(f, '{ half-writ');
    expect(safeRead(f, JSON.parse)).toEqual({ ok: false });
  });
});

describe('watchPath', () => {
  it('debounces a burst of writes into a single onChange', async () => {
    let calls = 0;
    const w = watchPath(root, () => { calls++; }, { debounceMs: 40 });
    writeFileSync(join(root, 'f1'), 'a');
    writeFileSync(join(root, 'f1'), 'b');
    writeFileSync(join(root, 'f2'), 'c');
    await new Promise((r) => setTimeout(r, 120));
    w.close();
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/watch.test.ts`
Expected: FAIL (`watch.mjs` not found).

- [ ] **Step 3: Implement `watch.mjs`**

```js
// plugins/p-observe/tools/lib/watch.mjs
import { readFileSync, watch as fsWatch, existsSync } from 'node:fs';

export function safeRead(path, parse) {
  try {
    const value = parse(readFileSync(path, 'utf-8'));
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

// Watches a directory, coalescing bursts into one debounced onChange().
// fs.watch event details are treated as a hint only — the caller re-reads state.
export function watchPath(target, onChange, { debounceMs = 150 } = {}) {
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
  };
  let watcher = null;
  if (existsSync(target)) {
    try { watcher = fsWatch(target, { recursive: false }, fire); }
    catch { watcher = null; } // platform without watch support -> caller may poll
  }
  return {
    close() { clearTimeout(timer); if (watcher) watcher.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/watch.mjs plugins/p-observe/tools/__tests__/watch.test.ts
git commit -m "feat(p-observe): debounced watch helper + torn-read-safe read"
```

---

### Task 6: p-shed adapter (`adapters/pshed.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/adapters/pshed.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-pshed.test.ts`

**Interfaces:**
- Consumes: `makeEvent` (Task 2), `paths` (Task 4), `safeRead`/`watchPath` (Task 5).
- Produces: `createPshedAdapter({ root, paths, cfg, emit }) → { backfill(), start(), stop(), status() }`.
  - `backfill()` reads today's `.pshed/logs/*.jsonl` and emits a `job.*` event per record: `action:'launched'|undefined` → `job.finished` (completions carry `exit`), `action:'skipped'|'not-due'|'baselined'` → `job.skipped`/`job.notdue`/`job.baselined`. Records with `exit` present are completions → `job.finished`.
  - `start()` watches `.pshed/run/` and emits `job.launched` when a new `<id>.pid` appears, and watches `.pshed/logs/` re-reading the current day file, emitting a `job.*` event for each newly-appended record (tracks byte offset per file). Records tolerated in old and new shapes.
  - `status()` → `{ running:[id...], jobs:{ [id]: { lastExit, lastAction } } }`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/adapter-pshed.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPshedAdapter } from '../lib/adapters/pshed.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-pshed-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setup() {
  const cfg = loadConfig(root);
  const p = paths(root, cfg);
  const events: any[] = [];
  const adapter = createPshedAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
  return { cfg, p, events, adapter };
}

describe('pshed adapter backfill', () => {
  it('maps today log records to job.* events', () => {
    const { p, events, adapter } = setup();
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const lines = [
      JSON.stringify({ ts: 1, job: 'daily', exit: 0, durationMs: 42000 }),
      JSON.stringify({ ts: 2, job: 'sync', action: 'skipped', reason: 'prev-run-alive' }),
    ].join('\n') + '\n';
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`), lines);

    adapter.backfill();

    expect(events.map((e) => e.kind)).toEqual(['job.finished', 'job.skipped']);
    expect(events[0]).toMatchObject({ plugin: 'p-shed', entity: 'daily', severity: 'ok' });
    expect(events[1]).toMatchObject({ entity: 'sync', kind: 'job.skipped', severity: 'info' });
  });

  it('marks a non-zero exit completion as error', () => {
    const { p, events, adapter } = setup();
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`),
      JSON.stringify({ ts: 3, job: 'lint', exit: 1, durationMs: 7000 }) + '\n');
    adapter.backfill();
    expect(events[0]).toMatchObject({ kind: 'job.finished', severity: 'error' });
  });
});

describe('pshed adapter status', () => {
  it('reports running jobs from pidfiles', () => {
    const { p, adapter } = setup();
    mkdirSync(p.pshedRunDir, { recursive: true });
    writeFileSync(join(p.pshedRunDir, 'daily.pid'), '1234');
    expect(adapter.status().running).toContain('daily');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-pshed.test.ts`
Expected: FAIL (`adapters/pshed.mjs` not found).

- [ ] **Step 3: Implement `adapters/pshed.mjs`**

```js
// plugins/p-observe/tools/lib/adapters/pshed.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath } from '../watch.mjs';

const today = () => new Date().toISOString().slice(0, 10);

function recordToEvent(rec) {
  const job = rec.job ?? '-';
  if (rec.action && rec.action !== 'launched') {
    const kind = { skipped: 'job.skipped', 'not-due': 'job.notdue', baselined: 'job.baselined' }[rec.action];
    if (!kind) return makeEvent('p-shed', 'job.action', job, `${rec.action}`, rec, rec.ts);
    const summary = rec.reason ? `${rec.action} (${rec.reason})` : rec.action;
    return makeEvent('p-shed', kind, job, summary, rec, rec.ts);
  }
  // a completion (has exit) or a launched marker
  if (rec.exit !== undefined) {
    const secs = rec.durationMs != null ? ` (${Math.round(rec.durationMs / 1000)}s)` : '';
    const summary = rec.timedOut ? `TIMEOUT${secs}` : `exit ${rec.exit}${secs}`;
    return makeEvent('p-shed', 'job.finished', job, summary, rec, rec.ts);
  }
  return makeEvent('p-shed', 'job.launched', job, 'launched', rec, rec.ts);
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function createPshedAdapter({ paths, emit }) {
  const offsets = new Map(); // logfile -> lines already emitted
  let watchers = [];

  function emitNewLogLines() {
    const dir = paths.pshedLogsDir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!/\.jsonl$/.test(name)) continue;
      const file = join(dir, name);
      const recs = readLines(file);
      const seen = offsets.get(file) ?? 0;
      for (let i = seen; i < recs.length; i++) emit(recordToEvent(recs[i]));
      offsets.set(file, recs.length);
    }
  }

  return {
    backfill() {
      const file = join(paths.pshedLogsDir, `${today()}.jsonl`);
      for (const rec of readLines(file)) emit(recordToEvent(rec));
      offsets.set(file, readLines(file).length);
    },
    start() {
      if (existsSync(paths.pshedLogsDir)) watchers.push(watchPath(paths.pshedLogsDir, emitNewLogLines));
      if (existsSync(paths.pshedRunDir)) {
        const known = new Set(existsSync(paths.pshedRunDir) ? readdirSync(paths.pshedRunDir) : []);
        watchers.push(watchPath(paths.pshedRunDir, () => {
          for (const name of readdirSync(paths.pshedRunDir)) {
            if (!known.has(name) && /\.pid$/.test(name)) {
              known.add(name);
              emit(makeEvent('p-shed', 'job.launched', name.replace(/\.pid$/, ''), 'launched'));
            }
          }
        }));
      }
    },
    stop() { for (const w of watchers) w.close(); watchers = []; },
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
      return { running, jobs };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-pshed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/pshed.mjs plugins/p-observe/tools/__tests__/adapter-pshed.test.ts
git commit -m "feat(p-observe): p-shed adapter (log tail + pidfile launches)"
```

---

### Task 7: p-tasks adapter (`adapters/ptasks.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/adapters/ptasks.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts`

**Interfaces:**
- Consumes: `makeEvent`, `paths`, `safeRead`/`watchPath`.
- Produces: `createPtasksAdapter({ root, paths, cfg, emit }) → { backfill(), start(), stop(), status() }`.
  - Uses a minimal YAML-subset reader? No — p-observe has no YAML dep. Instead it extracts `id`/`status` pairs from `tasks.yml` via a tolerant line scan (`readTaskStates(text) → Map<id, status>`), which is enough for diffing without a full YAML parser (zero-dep constraint). A torn/partial read yields the previous snapshot (no event, retry next tick).
  - `start()` on change diffs the new state map against the last snapshot: new id → `task.added`; missing id → `task.removed`; changed status → `task.status` (`old→new`).
  - `status()` → `{ counts: { [status]: n } }`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPtasksAdapter, readTaskStates } from '../lib/adapters/ptasks.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-ptasks-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const TASKS = `version: 1
tasks:
  - id: TASK-1
    title: A
    status: todo
  - id: TASK-2
    title: B
    status: in_progress
`;

function writeTasks(p: any, text: string) { mkdirSync(dirname(p.tasksFile), { recursive: true }); writeFileSync(p.tasksFile, text); }

describe('readTaskStates', () => {
  it('extracts id->status pairs tolerantly', () => {
    const m = readTaskStates(TASKS);
    expect(m.get('TASK-1')).toBe('todo');
    expect(m.get('TASK-2')).toBe('in_progress');
  });
});

describe('ptasks adapter diff', () => {
  it('emits task.status on a status change', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill(); // seed snapshot, no events
    expect(events).toEqual([]);
    writeTasks(p, TASKS.replace('status: todo', 'status: done'));
    a._diffNow(); // test seam: run the diff synchronously
    expect(events).toEqual([
      expect.objectContaining({ plugin: 'p-tasks', kind: 'task.status', entity: 'TASK-1', summary: 'todo → done' }),
    ]);
  });

  it('does not throw or advance baseline on a torn read', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill();
    writeTasks(p, '{ half writ'); // torn/partial
    expect(() => a._diffNow()).not.toThrow();
    expect(events).toEqual([]); // baseline unchanged
    writeTasks(p, TASKS.replace('status: todo', 'status: done'));
    a._diffNow();
    expect(events).toHaveLength(1); // diff still correct against the original baseline
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts`
Expected: FAIL (`adapters/ptasks.mjs` not found).

- [ ] **Step 3: Implement `adapters/ptasks.mjs`**

```js
// plugins/p-observe/tools/lib/adapters/ptasks.mjs
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath, safeRead } from '../watch.mjs';

// Zero-dep tolerant extractor: pair each `id:` with the nearest following `status:`
// within the same list item. Good enough for diffing without a YAML parser.
export function readTaskStates(text) {
  const map = new Map();
  const lines = text.split('\n');
  let pendingId = null;
  for (const line of lines) {
    const idM = /(?:^|\s)-?\s*id:\s*["']?([^"'\s]+)/.exec(line);
    if (idM) { pendingId = idM[1]; continue; }
    const stM = /(?:^|\s)status:\s*["']?([A-Za-z_]+)/.exec(line);
    if (stM && pendingId) { map.set(pendingId, stM[1]); pendingId = null; }
  }
  return map;
}

export function createPtasksAdapter({ paths, emit }) {
  let baseline = new Map();
  let watcher = null;

  const parse = (text) => readTaskStates(text);

  function readNow() {
    return safeRead(paths.tasksFile, parse); // {ok, value} | {ok:false}
  }

  function diffNow() {
    const r = readNow();
    if (!r.ok) return; // torn read — keep baseline, retry next tick
    const next = r.value;
    for (const [id, status] of next) {
      if (!baseline.has(id)) emit(makeEvent('p-tasks', 'task.added', id, `added (${status})`, { status }));
      else if (baseline.get(id) !== status) emit(makeEvent('p-tasks', 'task.status', id, `${baseline.get(id)} → ${status}`, { from: baseline.get(id), to: status }));
    }
    for (const id of baseline.keys()) if (!next.has(id)) emit(makeEvent('p-tasks', 'task.removed', id, 'removed', {}));
    baseline = next;
  }

  return {
    _diffNow: diffNow, // test seam
    backfill() { const r = readNow(); if (r.ok) baseline = r.value; },
    start() { if (existsSync(dirname(paths.tasksFile))) watcher = watchPath(dirname(paths.tasksFile), diffNow); },
    stop() { if (watcher) watcher.close(); watcher = null; },
    status() {
      const counts = {};
      for (const status of baseline.values()) counts[status] = (counts[status] ?? 0) + 1;
      return { counts };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/ptasks.mjs plugins/p-observe/tools/__tests__/adapter-ptasks.test.ts
git commit -m "feat(p-observe): p-tasks adapter (tasks.yml diff, torn-read safe)"
```

---

### Task 8: p-graph adapter (`adapters/pgraph.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/adapters/pgraph.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-pgraph.test.ts`

**Interfaces:**
- Consumes: `makeEvent`, `paths`, `cfg` (`pgraphCli`, `nodeBin`), `watchPath`.
- Produces: `createPgraphAdapter({ root, paths, cfg, emit, runStatus }) → { backfill(), start(), stop(), status() }`.
  - `runStatus` is an injected function `() → { schema_version, nodes, edges, files, drift, indexed_sha } | null` (null on failure/unset `pgraphCli`), defaulting to a real `execFileSync(cfg.nodeBin, [cfg.pgraphCli, 'status', '--json'])` wrapper. Injecting it keeps the adapter testable without a real pgraph.
  - On a `graph.db`/`-wal`/`-shm` change: if `runStatus()` returns counts, emit `index.refresh` with deltas vs. the last counts (and `drift.warn` when `drift > 0`); else emit a coarse mtime-only `index.refresh` (`summary:'db changed'`).
  - `status()` → last known counts (or `{}`).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/adapter-pgraph.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPgraphAdapter } from '../lib/adapters/pgraph.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-pgraph-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedDb(p: any) { mkdirSync(dirname(p.graphDb), { recursive: true }); writeFileSync(p.graphDb, 'x'); }

describe('pgraph adapter with counts', () => {
  it('emits index.refresh with deltas and drift.warn', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg); seedDb(p);
    const events: any[] = [];
    let counts = { nodes: 100, edges: 40, files: 5, drift: 0, schema_version: 3, indexed_sha: 'aaa' };
    const a = createPgraphAdapter({ root, paths: p, cfg, emit: (e) => events.push(e), runStatus: () => counts });
    a.backfill(); // seeds baseline, no event
    counts = { ...counts, nodes: 118, drift: 2 };
    a._onChange();
    expect(events.map((e) => e.kind)).toEqual(['index.refresh', 'drift.warn']);
    expect(events[0].summary).toMatch(/\+18 nodes/);
    expect(events[1].severity).toBe('warn');
  });
});

describe('pgraph adapter degraded (no pgraphCli)', () => {
  it('emits a coarse mtime-only index.refresh', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg); seedDb(p);
    const events: any[] = [];
    const a = createPgraphAdapter({ root, paths: p, cfg, emit: (e) => events.push(e), runStatus: () => null });
    a._onChange();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'index.refresh', summary: 'db changed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-pgraph.test.ts`
Expected: FAIL (`adapters/pgraph.mjs` not found).

- [ ] **Step 3: Implement `adapters/pgraph.mjs`**

```js
// plugins/p-observe/tools/lib/adapters/pgraph.mjs
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath } from '../watch.mjs';

function defaultRunStatus(cfg) {
  return () => {
    if (!cfg.pgraphCli) return null;
    try {
      const out = execFileSync(cfg.nodeBin, [cfg.pgraphCli, 'status', '--json'], { encoding: 'utf-8' });
      return JSON.parse(out);
    } catch { return null; }
  };
}

export function createPgraphAdapter({ paths, cfg, emit, runStatus }) {
  const status = runStatus ?? defaultRunStatus(cfg);
  let last = null; // last counts
  let watcher = null;

  function onChange() {
    const s = status();
    if (!s) { emit(makeEvent('p-graph', 'index.refresh', '-', 'db changed', { error: !cfg.pgraphCli ? undefined : true })); return; }
    const d = last ? (s.nodes - last.nodes) : 0;
    const sign = d >= 0 ? `+${d}` : `${d}`;
    const summary = last ? `${sign} nodes (${s.nodes} total)` : `${s.nodes} nodes indexed`;
    emit(makeEvent('p-graph', 'index.refresh', '-', summary, s));
    if (s.drift > 0) emit(makeEvent('p-graph', 'drift.warn', '-', `drift ${s.drift} files`, s));
    last = s;
  }

  return {
    _onChange: onChange, // test seam
    backfill() { const s = status(); if (s) last = s; },
    start() { if (existsSync(dirname(paths.graphDb))) watcher = watchPath(dirname(paths.graphDb), onChange); },
    stop() { if (watcher) watcher.close(); watcher = null; },
    status() { return last ?? {}; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-pgraph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/pgraph.mjs plugins/p-observe/tools/__tests__/adapter-pgraph.test.ts
git commit -m "feat(p-observe): p-graph adapter (mtime watch + pgraph status, degrade-safe)"
```

---

### Task 9: p-wiki adapter (`adapters/pwiki.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/adapters/pwiki.mjs`
- Test: `plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts`

**Interfaces:**
- Consumes: `makeEvent`, `paths`, `watchPath`, `safeRead`.
- Produces: `createPwikiAdapter({ root, paths, cfg, emit }) → { backfill(), start(), stop(), status(), enabled() }`.
  - `enabled()` reads `docs/wiki/.pwiki.json`; returns `false` when `primary === 'confluence'` and no fs mirror (adapter is a no-op then — Confluence-primary blind zone).
  - Uses a tiny frontmatter reader `readFrontmatter(text) → { compiled?, 'conflict-since'?, ... }` (zero-dep: parse the leading `---`…`---` block as `key: value` lines).
  - `start()` watches `docs/wiki/pages/` and `docs/wiki/raw/`; on change it re-scans page files and diffs against the last snapshot map `path → { conflict, compiled }`: new file → `page.compiled` (if under pages) / `raw.ingested` (if under raw); removed → `page.removed`; `conflict-since` appeared → `wiki.conflict`; `index.json` mtime change → `wiki.reindex`.
  - `status()` → `{ pages, raw, conflicts }` counts.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPwikiAdapter, readFrontmatter } from '../lib/adapters/pwiki.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-pwiki-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const page = (fm: Record<string, string>) =>
  '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\nbody\n';

describe('readFrontmatter', () => {
  it('parses the leading fenced block', () => {
    expect(readFrontmatter(page({ title: 'X', 'conflict-since': '2026-06-05' }))['conflict-since']).toBe('2026-06-05');
  });
  it('returns {} when there is no frontmatter', () => {
    expect(readFrontmatter('no fm here')).toEqual({});
  });
});

describe('pwiki adapter', () => {
  function mk() {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.wikiPagesDir, { recursive: true });
    const events: any[] = [];
    const a = createPwikiAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    return { cfg, p, events, a };
  }

  it('emits wiki.conflict when conflict-since appears', () => {
    const { p, events, a } = mk();
    const f = join(p.wikiPagesDir, 'concept', 'auth.md');
    mkdirSync(join(p.wikiPagesDir, 'concept'), { recursive: true });
    writeFileSync(f, page({ title: 'Auth' }));
    a.backfill();
    writeFileSync(f, page({ title: 'Auth', 'conflict-since': '2026-07-17' }));
    a._scanNow();
    expect(events.find((e) => e.kind === 'wiki.conflict')).toMatchObject({ plugin: 'p-wiki', severity: 'warn' });
  });

  it('is disabled for a Confluence-primary wiki with no fs mirror', () => {
    const { p, a } = mk();
    writeFileSync(p.pwikiConfig, JSON.stringify({ primary: 'confluence', mirrors: [] }));
    expect(a.enabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts`
Expected: FAIL (`adapters/pwiki.mjs` not found).

- [ ] **Step 3: Implement `adapters/pwiki.mjs`**

```js
// plugins/p-observe/tools/lib/adapters/pwiki.mjs
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath, safeRead } from '../watch.mjs';

export function readFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return fm;
}

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walkMd(abs, acc);
    else if (e.name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

export function createPwikiAdapter({ paths, emit }) {
  let snap = new Map(); // absPath -> { conflict:boolean, raw:boolean }
  let watchers = [];

  function scan() {
    const map = new Map();
    for (const f of walkMd(paths.wikiPagesDir)) {
      const r = safeRead(f, readFrontmatter);
      map.set(f, { conflict: r.ok ? !!r.value['conflict-since'] : false, raw: false });
    }
    for (const f of walkMd(paths.wikiRawDir)) map.set(f, { conflict: false, raw: true });
    return map;
  }

  function scanNow() {
    const next = scan();
    for (const [f, meta] of next) {
      const prev = snap.get(f);
      if (!prev) emit(makeEvent('p-wiki', meta.raw ? 'raw.ingested' : 'page.compiled', basename(f), meta.raw ? 'ingested' : 'compiled', {}));
      else if (meta.conflict && !prev.conflict) emit(makeEvent('p-wiki', 'wiki.conflict', basename(f), 'conflict flagged', {}));
      else if (!prev.raw && !meta.raw && prev.conflict === meta.conflict) { /* unchanged flag */ }
    }
    for (const f of snap.keys()) if (!next.has(f)) emit(makeEvent('p-wiki', 'page.removed', basename(f), 'removed', {}));
    snap = next;
  }

  return {
    _scanNow: scanNow, // test seam
    enabled() {
      const r = safeRead(paths.pwikiConfig, JSON.parse);
      if (r.ok && r.value.primary === 'confluence') {
        const hasFsMirror = Array.isArray(r.value.mirrors) && r.value.mirrors.some((m) => /fs/.test(m));
        return hasFsMirror;
      }
      return true;
    },
    backfill() { snap = scan(); },
    start() {
      if (existsSync(paths.wikiPagesDir)) watchers.push(watchPath(paths.wikiPagesDir, scanNow));
      if (existsSync(paths.wikiRawDir)) watchers.push(watchPath(paths.wikiRawDir, scanNow));
      if (existsSync(paths.wikiDir)) watchers.push(watchPath(paths.wikiDir, () => {
        if (existsSync(paths.wikiIndexJson)) emit(makeEvent('p-wiki', 'wiki.reindex', 'index.json', 'index regenerated', {}));
      }));
    },
    stop() { for (const w of watchers) w.close(); watchers = []; },
    status() {
      let pages = 0, raw = 0, conflicts = 0;
      for (const meta of snap.values()) { if (meta.raw) raw++; else { pages++; if (meta.conflict) conflicts++; } }
      return { pages, raw, conflicts };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/adapters/pwiki.mjs plugins/p-observe/tools/__tests__/adapter-pwiki.test.ts
git commit -m "feat(p-observe): p-wiki adapter (frontmatter watch, Confluence-aware)"
```

---

### Task 10: Journal sink + replay (`journal.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/journal.mjs`
- Test: `plugins/p-observe/tools/__tests__/journal.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces:
  - `appendJournal(journalFile, event)` — appends one JSON line, creating the dir.
  - `rotateJournal(journalDir, nowMs, retentionDays)` — deletes dated journal files older than the window (mirrors p-shed `rotateLogs`; journal is written as `<journalDir>/events.jsonl` for the live file plus dated archives on rotation — for Phase 1 a single `events.jsonl` is kept and rotation truncates by line-age is out of scope; this fn deletes dated `*.jsonl` beyond retention, matching the config field).
  - `replayJournal(journalFile) → Event[]` — reads and JSON-parses each line, skipping unparseable lines; returns `[]` when the file is absent.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/journal.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, replayJournal } from '../lib/journal.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pobs-jrnl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('journal round-trip', () => {
  it('append then replay returns equal events, skipping junk lines', () => {
    const file = join(dir, 'events.jsonl');
    const e1 = { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} };
    const e2 = { ts: 2, plugin: 'p-tasks', kind: 'task.status', entity: 'T', severity: 'info', summary: 'y', data: {} };
    appendJournal(file, e1); appendJournal(file, e2);
    // corrupt trailing line tolerated
    require('node:fs').appendFileSync(file, '{ half\n');
    expect(replayJournal(file)).toEqual([e1, e2]);
  });
  it('replay returns [] when the file is absent', () => {
    expect(replayJournal(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/journal.test.ts`
Expected: FAIL (`journal.mjs` not found).

- [ ] **Step 3: Implement `journal.mjs`**

```js
// plugins/p-observe/tools/lib/journal.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function appendJournal(journalFile, event) {
  mkdirSync(dirname(journalFile), { recursive: true });
  appendFileSync(journalFile, JSON.stringify(event) + '\n', 'utf-8');
}

export function replayJournal(journalFile) {
  if (!existsSync(journalFile)) return [];
  return readFileSync(journalFile, 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Deletes dated archive files (YYYY-MM-DD.jsonl) older than retentionDays.
export function rotateJournal(journalDir, nowMs, retentionDays = 7) {
  if (!existsSync(journalDir)) return [];
  const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
  const cutoff = Date.parse(dayStr(nowMs) + 'T00:00:00Z') - retentionDays * 86400000;
  const deleted = [];
  for (const name of readdirSync(journalDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) { rmSync(join(journalDir, name), { force: true }); deleted.push(name); }
  }
  return deleted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/journal.mjs plugins/p-observe/tools/__tests__/journal.test.ts
git commit -m "feat(p-observe): journal sink (append/replay/rotate)"
```

---

### Task 11: Renderers (`render/stream.mjs`, `render/status.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/render/stream.mjs`
- Create: `plugins/p-observe/tools/lib/render/status.mjs`
- Test: `plugins/p-observe/tools/__tests__/render.test.ts`

**Interfaces:**
- Consumes: the canonical `Event` shape.
- Produces:
  - `formatLine(event, { color = false }) → string` — `HH:MM:SS  <plugin>  <glyph> <summary>` (glyph by severity). `color:false` (default) yields plain text for tests/pipes.
  - `formatStatus(snapshot) → string` — a multi-line rollup where `snapshot = { pshed?, ptasks?, pgraph?, wiki? }` holds each adapter's `status()` output (absent adapters omitted).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/render.test.ts
import { describe, expect, it } from 'vitest';
import { formatLine } from '../lib/render/stream.mjs';
import { formatStatus } from '../lib/render/status.mjs';

const ev = { ts: Date.parse('2026-07-17T14:03:54Z'), plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0 (42s)', data: {} };

describe('formatLine', () => {
  it('renders time, plugin, glyph, summary (plain)', () => {
    const line = formatLine(ev, { color: false });
    expect(line).toContain('p-shed');
    expect(line).toContain('exit 0 (42s)');
    expect(line).toMatch(/\d\d:\d\d:\d\d/);
  });
  it('has no ANSI escapes when color is false', () => {
    expect(formatLine(ev, { color: false })).not.toMatch(/\[/);
  });
});

describe('formatStatus', () => {
  it('summarizes present adapters and omits absent ones', () => {
    const out = formatStatus({
      pshed: { running: ['daily'], jobs: { daily: { lastExit: 0 }, lint: { lastExit: 1 } } },
      ptasks: { counts: { todo: 3, in_progress: 1 } },
    });
    expect(out).toMatch(/p-shed/);
    expect(out).toMatch(/running/);
    expect(out).toMatch(/p-tasks/);
    expect(out).not.toMatch(/p-graph/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/render.test.ts`
Expected: FAIL (render modules not found).

- [ ] **Step 3: Implement the renderers**

```js
// plugins/p-observe/tools/lib/render/stream.mjs
const GLYPH = { ok: '✓', info: '•', warn: '⚠', error: '✗' };
const COLOR = { ok: 32, info: 36, warn: 33, error: 31 };

function hhmmss(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatLine(event, { color = false } = {}) {
  const glyph = GLYPH[event.severity] ?? '•';
  const plugin = event.plugin.padEnd(8);
  const body = `${hhmmss(event.ts)}  ${plugin} ${glyph} ${event.entity !== '-' ? event.entity + '  ' : ''}${event.summary}`;
  if (!color) return body;
  return `[${COLOR[event.severity] ?? 36}m${body}[0m`;
}
```

```js
// plugins/p-observe/tools/lib/render/status.mjs
export function formatStatus(snapshot) {
  const lines = [];
  if (snapshot.pshed) {
    const s = snapshot.pshed;
    const failed = Object.values(s.jobs ?? {}).filter((j) => j.lastExit && j.lastExit !== 0).length;
    lines.push(`p-shed   ${Object.keys(s.jobs ?? {}).length} jobs · ${s.running.length} running · ${failed} failed`);
  }
  if (snapshot.ptasks) {
    const c = snapshot.ptasks.counts ?? {};
    lines.push(`p-tasks  ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no tasks'}`);
  }
  if (snapshot.pgraph) {
    const g = snapshot.pgraph;
    lines.push(`p-graph  ${g.nodes ?? '?'} nodes · drift ${g.drift ?? '?'}`);
  }
  if (snapshot.wiki) {
    const w = snapshot.wiki;
    lines.push(`p-wiki   ${w.pages ?? 0} pages · ${w.raw ?? 0} raw · ${w.conflicts ?? 0} conflicts`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/render/stream.mjs plugins/p-observe/tools/lib/render/status.mjs plugins/p-observe/tools/__tests__/render.test.ts
git commit -m "feat(p-observe): stream + status renderers"
```

---

### Task 12: CLI wiring — `watch` / `status` / `capture` (`pobserve.mjs` + `lib/core.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/core.mjs`
- Modify: `plugins/p-observe/tools/pobserve.mjs` (replace the stub dispatch with real command wiring)
- Test: `plugins/p-observe/tools/__tests__/core.test.ts`
- Test: `plugins/p-observe/tools/__tests__/cli-e2e.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`detectPlugins`/`paths`, `createBus`, all four `create*Adapter`, `formatLine`/`formatStatus`, `appendJournal`/`replayJournal`, `makeEvent`.
- Produces:
  - `buildAdapters({ root, cfg, paths, detected, emit }) → { pshed?, ptasks?, pgraph?, wiki? }` — instantiate only detected adapters (wiki additionally gated by `enabled()`).
  - `runBackfill(adapters, { paths, cfg, emit }) → void` — if `paths.journalFile` exists, replay it via `emit`; else call each adapter's `backfill()`.
  - `collectStatus(adapters) → snapshot` — call each adapter's `status()` keyed by plugin.
  - `pobserve.mjs`: `status` prints `formatStatus(collectStatus(...))` and exits; `watch` subscribes `formatLine` to the bus (and `appendJournal` when `--journal`), backfills, starts adapters, and streams; `capture` is `watch` with the journal sink on and no stdout renderer.

- [ ] **Step 1: Write the failing test (core)**

```ts
// plugins/p-observe/tools/__tests__/core.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths, detectPlugins } from '../lib/config.mjs';
import { buildAdapters, runBackfill, collectStatus } from '../lib/core.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-core-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('runBackfill', () => {
  it('prefers the journal when present', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.journalDir, { recursive: true });
    writeFileSync(p.journalFile, JSON.stringify({ ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} }) + '\n');
    const events: any[] = [];
    const adapters = buildAdapters({ root, cfg, paths: p, detected: { pshed: false, ptasks: false, pgraph: false, wiki: false }, emit: (e) => events.push(e) });
    runBackfill(adapters, { paths: p, cfg, emit: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    expect(events[0].entity).toBe('a');
  });

  it('falls back to adapter backfill when no journal', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`), JSON.stringify({ ts: 1, job: 'daily', exit: 0 }) + '\n');
    const detected = detectPlugins(root, cfg);
    const events: any[] = [];
    const adapters = buildAdapters({ root, cfg, paths: p, detected, emit: (e) => events.push(e) });
    runBackfill(adapters, { paths: p, cfg, emit: (e) => events.push(e) });
    expect(events.map((e) => e.kind)).toContain('job.finished');
  });
});

describe('collectStatus', () => {
  it('keys each adapter status by plugin', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.pshedRunDir, { recursive: true });
    writeFileSync(join(p.pshedRunDir, 'daily.pid'), '1');
    const adapters = buildAdapters({ root, cfg, paths: p, detected: { pshed: true, ptasks: false, pgraph: false, wiki: false }, emit: () => {} });
    expect(collectStatus(adapters).pshed.running).toContain('daily');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/core.test.ts`
Expected: FAIL (`core.mjs` not found).

- [ ] **Step 3: Implement `lib/core.mjs`**

```js
// plugins/p-observe/tools/lib/core.mjs
import { existsSync } from 'node:fs';
import { createPshedAdapter } from './adapters/pshed.mjs';
import { createPtasksAdapter } from './adapters/ptasks.mjs';
import { createPgraphAdapter } from './adapters/pgraph.mjs';
import { createPwikiAdapter } from './adapters/pwiki.mjs';
import { replayJournal } from './journal.mjs';

export function buildAdapters({ root, cfg, paths, detected, emit }) {
  const a = {};
  if (detected.pshed) a.pshed = createPshedAdapter({ root, paths, cfg, emit });
  if (detected.ptasks) a.ptasks = createPtasksAdapter({ root, paths, cfg, emit });
  if (detected.pgraph) a.pgraph = createPgraphAdapter({ root, paths, cfg, emit });
  if (detected.wiki) {
    const w = createPwikiAdapter({ root, paths, cfg, emit });
    if (w.enabled()) a.wiki = w; // Confluence-primary blind zone -> skip
  }
  return a;
}

export function runBackfill(adapters, { paths, emit }) {
  if (existsSync(paths.journalFile)) {
    for (const e of replayJournal(paths.journalFile)) emit(e);
    return;
  }
  for (const ad of Object.values(adapters)) ad.backfill();
}

export function startAll(adapters) { for (const ad of Object.values(adapters)) ad.start(); }
export function stopAll(adapters) { for (const ad of Object.values(adapters)) ad.stop(); }

export function collectStatus(adapters) {
  const snap = {};
  for (const [name, ad] of Object.entries(adapters)) snap[name] = ad.status();
  return snap;
}
```

- [ ] **Step 4: Run core test to verify it passes**

Run: `npx vitest run plugins/p-observe/tools/__tests__/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CLI in `pobserve.mjs`**

Replace the whole `main` body in `plugins/p-observe/tools/pobserve.mjs` with:

```js
// plugins/p-observe/tools/pobserve.mjs
import { loadConfig, detectPlugins, paths as resolvePaths } from './lib/config.mjs';
import { createBus } from './lib/bus.mjs';
import { buildAdapters, runBackfill, startAll, stopAll, collectStatus } from './lib/core.mjs';
import { formatLine } from './lib/render/stream.mjs';
import { formatStatus } from './lib/render/status.mjs';
import { appendJournal } from './lib/journal.mjs';

const USAGE = `Usage: pobserve <command> [options]

Commands:
  watch     Live merged event stream across observed plugins
  status    One-shot snapshot (counters + running/failed)
  capture   Headless: run the bus + on-disk journal, no UI
  help      Show this help

Options:
  --plugin=<name>    filter to one plugin (watch)
  --severity=<lvl>   filter by min severity: ok|info|warn|error (watch)
  --journal          also append events to .pobserve/events.jsonl (watch)
`;

const SEV_ORDER = { ok: 0, info: 1, warn: 2, error: 3 };
const KNOWN = new Set(['watch', 'status', 'capture', 'help']);

function parseOpts(argv) {
  const o = { color: process.stdout.isTTY };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] ?? true;
  }
  return o;
}

function assemble(root, emit) {
  const cfg = loadConfig(root);
  const paths = resolvePaths(root, cfg);
  const detected = detectPlugins(root, cfg);
  const adapters = buildAdapters({ root, cfg, paths, detected, emit });
  return { cfg, paths, adapters };
}

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help') { process.stdout.write(USAGE); return 0; }
  if (!KNOWN.has(command)) { process.stderr.write(`unknown command: ${command}\n`); return 2; }
  const root = process.cwd();
  const opts = parseOpts(argv.slice(1));

  if (command === 'status') {
    const { adapters } = assemble(root, () => {});
    for (const ad of Object.values(adapters)) ad.backfill(); // seed snapshots
    process.stdout.write(formatStatus(collectStatus(adapters)) + '\n');
    return 0;
  }

  // watch / capture: build bus first, then adapters that emit into it.
  const cfg0 = loadConfig(root);
  const bus = createBus({ size: cfg0.bufferSize });
  const { paths, adapters } = assemble(root, bus.push);

  const journalOn = command === 'capture' || opts.journal === true || cfg0.journal === true;
  if (journalOn) bus.subscribe((e) => appendJournal(paths.journalFile, e));

  if (command === 'watch') {
    const minSev = SEV_ORDER[opts.severity] ?? 0;
    bus.subscribe((e) => {
      if (opts.plugin && e.plugin !== opts.plugin && e.plugin !== `p-${opts.plugin}`) return;
      if (SEV_ORDER[e.severity] < minSev) return;
      process.stdout.write(formatLine(e, { color: opts.color }) + '\n');
    });
  } else {
    process.stderr.write('pobserve capture: journaling events (Ctrl-C to stop)\n');
  }

  runBackfill(adapters, { paths, cfg: cfg0, emit: bus.push });
  startAll(adapters);

  await new Promise((resolve) => {
    process.on('SIGINT', () => { stopAll(adapters); resolve(); });
    process.on('SIGTERM', () => { stopAll(adapters); resolve(); });
  });
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
```

- [ ] **Step 6: Write the failing e2e test**

```ts
// plugins/p-observe/tools/__tests__/cli-e2e.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pobserve.mjs');
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-e2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('pobserve status (e2e)', () => {
  it('reports p-shed running jobs from a real .pshed tree', () => {
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'run', 'daily.pid'), '4321');
    const out = execFileSync('node', [CLI, 'status'], { cwd: root, encoding: 'utf-8' });
    expect(out).toMatch(/p-shed/);
    expect(out).toMatch(/running/);
  });
});
```

- [ ] **Step 7: Run all p-observe tests to verify they pass**

Run: `npx vitest run plugins/p-observe`
Expected: PASS (all specs).

- [ ] **Step 8: Commit**

```bash
git add plugins/p-observe/tools/lib/core.mjs plugins/p-observe/tools/pobserve.mjs plugins/p-observe/tools/__tests__/core.test.ts plugins/p-observe/tools/__tests__/cli-e2e.test.ts
git commit -m "feat(p-observe): wire watch/status/capture commands + core assembly"
```

---

### Task 13: Skills, docs, packaging (`init` / `watch` / `help`, README, CLAUDE.md, gitignore)

**Files:**
- Create: `plugins/p-observe/skills/init/SKILL.md`
- Create: `plugins/p-observe/skills/watch/SKILL.md`
- Create: `plugins/p-observe/skills/help/SKILL.md`
- Create: `plugins/p-observe/README.md`
- Create: `plugins/p-observe/CLAUDE.md`
- Modify: `.gitignore` (append `.pobserve/`)
- Test: `plugins/p-observe/tools/__tests__/skills-structure.test.ts`

**Interfaces:**
- Consumes: nothing at runtime. This task delivers the discoverable surface + ignore rule.
- Produces: three skills with valid frontmatter (`name`, `description`), user/contributor docs, and a gitignore entry so p-observe's own `.pobserve/` never gets committed.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-observe/tools/__tests__/skills-structure.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('p-observe skills', () => {
  for (const name of ['init', 'watch', 'help']) {
    it(`${name} skill exists with name+description frontmatter`, () => {
      const p = join(PLUGIN, 'skills', name, 'SKILL.md');
      expect(existsSync(p)).toBe(true);
      const md = readFileSync(p, 'utf-8');
      expect(md).toMatch(/^---[\s\S]*\bname:\s*\S+[\s\S]*\bdescription:\s*\S+[\s\S]*---/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-observe/tools/__tests__/skills-structure.test.ts`
Expected: FAIL (skills not present).

- [ ] **Step 3: Create `skills/help/SKILL.md`**

```markdown
---
name: help
description: Show the pobserve command cheat-sheet and what p-observe can see. Use when the user says "p-observe help" or asks what pobserve can do.
---

# /p-observe:help

Run the CLI's own help and relay it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" help
```

p-observe is a **zero-touch** observer. It watches, but never modifies, the runtime state of
p-shed, p-tasks, p-graph, and p-wiki in the current repo, and prints a normalized event stream.

- `pobserve watch` — live merged stream (`--plugin=`, `--severity=`, `--journal`).
- `pobserve status` — one-shot snapshot (counters + running/failed).
- `pobserve capture` — headless; keep it running to persist the full offline timeline to `.pobserve/events.jsonl`.

Blind zones (by design): a Jira-primary p-tasks and a Confluence-primary p-wiki have no local
files to watch; p-graph shows aggregate counts (needs `pgraphCli` configured), not per-symbol changes.
```

- [ ] **Step 4: Create `skills/watch/SKILL.md`**

```markdown
---
name: watch
description: Start the live p-observe event stream for the current repo. Use when the user says "watch plugins", "show plugin activity", "what are the plugins doing", or "stream p-observe".
---

# /p-observe:watch

Launch the live stream. This is a long-running foreground process — tell the user to press Ctrl-C to stop.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" watch
```

Options to offer:
- `--plugin=shed|tasks|graph|wiki` — filter to one plugin.
- `--severity=warn` — only warnings and errors.
- `--journal` — also persist events to `.pobserve/events.jsonl`.

For "what happened while I was away", prefer keeping `pobserve capture` running continuously (it
persists the full timeline); a later `watch` backfills from that journal. Without a running capturer,
a cold `watch` shows p-shed's full log plus the current end-state of the other three (§ design spec).
```

- [ ] **Step 5: Create `skills/init/SKILL.md`**

```markdown
---
name: init
description: Initialize p-observe in the current repo — detect which observed plugins are present, resolve the p-graph CLI path for counts, and write an optional .pobserve.json. Use when the user says "init p-observe" or "set up plugin observability".
---

# /p-observe:init

You are setting up p-observe in the current git repo.

## Step 1 — Find the repo root
`<root>` = `git rev-parse --show-toplevel`.

## Step 2 — Detect observed plugins
Report which of these exist under `<root>`: `.pshed/`, `docs/tasks/tasks.yml`, `.pgraph/graph.db`, `docs/wiki/`.
For `docs/wiki/.pwiki.json`, if `primary` is `confluence` with no fs mirror, tell the user the wiki adapter will be skipped (no local files to watch).

## Step 3 — Resolve the p-graph CLI (optional, enables node/edge counts)
There is **no automatic path** to another plugin's install dir. Probe the known install locations:

```bash
ls ~/.claude/plugins/cache/*/p-graph/tools/pgraph.mjs \
   ~/.claude/plugins/marketplaces/*/plugins/p-graph/tools/pgraph.mjs 2>/dev/null
```

- Exactly one match → propose it as `pgraphCli` and ask the user to confirm.
- Zero or multiple → ask the user to paste the path (or skip; the graph adapter then shows coarse "db changed" events without counts).

## Step 4 — Write `.pobserve.json` (only if the user overrides a default)
Write only the keys that differ from defaults, e.g.:

```json
{ "pgraphCli": "/home/you/.claude/plugins/cache/perky-team/p-graph/tools/pgraph.mjs" }
```

## Step 5 — Confirm `.pobserve/` is gitignored
Ensure `<root>/.gitignore` contains `.pobserve/`. If not, add it.

## Step 6 — Offer next step
Suggest `/p-observe:watch` (live) or a background `pobserve capture` for full offline capture.
```

- [ ] **Step 6: Create `README.md`**

```markdown
# p-observe

A Claude Code plugin that gives a **realtime, human-readable view** of what the other perky.team
plugins are doing at runtime — a `tail -f`-style stream plus a live snapshot — without modifying them.

Zero-touch: it only reads `.pshed/`, `docs/tasks/`, `.pgraph/`, and `docs/wiki/`, and derives a
normalized event stream. Its own writes go only under `.pobserve/` (gitignored).

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-observe@perky.team
```

## Commands

| Command | What it does |
|---|---|
| `pobserve watch` | Live merged event stream (`--plugin=`, `--severity=`, `--journal`). |
| `pobserve status` | One-shot snapshot: counters, running jobs, failures. |
| `pobserve capture` | Headless; keep running to persist the full offline timeline to `.pobserve/events.jsonl`. |

Run via `node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" <command>`.

## Skills

| Skill | What it does |
|---|---|
| `/p-observe:init` | Detect present plugins, resolve the p-graph CLI, write optional `.pobserve.json`. |
| `/p-observe:watch` | Launch the live stream. |
| `/p-observe:help` | Command cheat-sheet. |

## What it can and can't see

- **p-shed** — full job history (from its own log) + live launches.
- **p-tasks** — status transitions from `tasks.yml`. A **Jira-primary** tracker has no local file → invisible.
- **p-graph** — aggregate node/edge/drift deltas (needs `pgraphCli` for counts; else "db changed").
- **p-wiki** — page compiles/edits/conflicts from frontmatter. A **Confluence-primary** wiki → invisible.

See `docs/superpowers/specs/2026-07-17-p-observe-design.md` for the full design.

## Requirements

Node ≥ 18. No external dependencies.
```

- [ ] **Step 7: Create `CLAUDE.md`**

```markdown
# p-observe — contributor guide

Zero-touch observer. Key decisions:

- **Never modify observed plugins.** Adapters only read `.pshed/`, `docs/tasks/`, `.pgraph/`,
  `docs/wiki/`. All p-observe writes go under `.pobserve/`.
- **Never open `graph.db`.** That would force Node ≥ 22.5 and couple to p-graph's schema. The
  p-graph adapter only shells out to `pgraph status --json` and degrades to mtime-only when the
  CLI path is unset.
- **Torn-read rule.** Every parse-on-change adapter catches parse errors, keeps its prior snapshot
  as the baseline, and retries next tick — the observed plugins write non-atomically.
- **Zero runtime deps.** Nothing under `tools/` may `import` a bare package. Node built-ins + ANSI only.
- Adapter contract: `{ backfill(), start(), stop(), status() }`; the bus (`lib/bus.mjs`) is the only
  fan-out. Renderers and the journal sink are subscribers.
- Phase 2 (TUI) and the p-shed log enrichment are separate plans; see the design spec.
```

- [ ] **Step 8: Append the ignore rule to root `.gitignore`**

Add a line `.pobserve/` to `<repo-root>/.gitignore`.

- [ ] **Step 9: Run the structure test + full suite**

Run: `npx vitest run plugins/p-observe`
Expected: PASS (all specs, including `skills-structure.test.ts`).

- [ ] **Step 10: Validate the plugin manifest**

Run: `node scripts/validate.mjs`
Expected: p-observe validates with no errors.

- [ ] **Step 11: Commit**

```bash
git add plugins/p-observe/skills plugins/p-observe/README.md plugins/p-observe/CLAUDE.md plugins/p-observe/tools/__tests__/skills-structure.test.ts .gitignore
git commit -m "feat(p-observe): init/watch/help skills, docs, gitignore"
```

---

## Self-Review

**Spec coverage check (spec §→ task):**
- §3 zero-touch + auto-detect + `.pobserve.json` → Tasks 4, 13 (init).
- §4 four layers (adapters/normalizer/bus/renderers) → Tasks 2, 3, 6–9, 11, 12.
- §5 event model → Task 2.
- §6 adapters (p-shed/p-tasks/p-graph/p-wiki), severity, conflict-since, pgraph soft-dep, watcher/torn-read/WAL → Tasks 6, 7, 8, 9 (WAL: Task 8 watches `dirname(graphDb)`, which covers `graph.db`, `-wal`, `-shm` as they share a directory; torn-read: Task 7 test).
- §8 CLI surface (`watch`/`status`/`capture`) + skills → Tasks 12, 13.
- §9 UI (TUI) → **Phase 2, out of scope** (stated in Global Constraints).
- §10 backfill + journal sink → Tasks 10, 12 (`runBackfill`).
- §11 constraints (Node ≥18, zero-dep, no sqlite) → Global Constraints + Task 8 (never opens db).
- §12 testing (adapters, torn-read, degrade, journal round-trip) → Tasks 6–10 tests.
- §13 phasing → this plan is Phase 1; Phase 2 + p-shed enrichment noted as separate plans.
- §14 backlog → not implemented (correct — deferred).

**Coverage note (accepted scope cut):** cron→next-due (spec §6 p-shed "next-due") is deferred to Phase 2 (panel sugar), stated in Global Constraints. The `job.launched`-race and ring-buffer-truncation notes (spec §10) are inherent behaviors, not tasks. The WAL edge (`-wal`/`-shm`) is covered because Task 8 watches the containing directory rather than the single file — if a stricter per-file watch is later chosen, add the sibling paths explicitly.

**Placeholder scan:** no TBD/TODO; every code step carries complete code; every test step carries real assertions.

**Type consistency:** adapter factory names (`createPshedAdapter`/`createPtasksAdapter`/`createPgraphAdapter`/`createPwikiAdapter`) and the `{ backfill, start, stop, status }` contract are consistent across Tasks 6–9 and consumed identically in Task 12 `buildAdapters`. `makeEvent(plugin, kind, entity, summary, data, ts)` signature is used consistently. `paths()` keys referenced by adapters (`pshedLogsDir`, `pshedRunDir`, `pshedStateDir`, `tasksFile`, `graphDb`, `wikiPagesDir`, `wikiRawDir`, `wikiIndexJson`, `pwikiConfig`, `journalFile`) are all defined in Task 4.
