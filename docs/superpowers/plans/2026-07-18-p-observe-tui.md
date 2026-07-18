# p-observe TUI (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a k9s-style terminal UI (`pobserve tui`) to p-observe — tabbed Overview + per-plugin master-detail views over the existing event bus — as specified in §9 of `docs/superpowers/specs/2026-07-17-p-observe-design.md`.

**Architecture:** The TUI is a second bus subscriber, not a separate program. All rendering is a pure function `render(state, {color}) → string[]`; all key handling is a pure reducer `reduce(state, token) → state`; entity lists are derived from the in-memory event buffer (`bus.snapshot()`) plus `collectStatus(adapters)`. A thin impure driver (`driver.mjs`) owns the terminal (alt-screen, raw stdin, resize, render throttling) and injects live data into the pure core each frame. This keeps the whole UI snapshot-testable without a real terminal (§12).

**Tech Stack:** Node ≥ 18, zero external deps (raw ANSI + `node:process` stdin/stdout only). Tests: vitest (`npm test` from repo root, files `plugins/p-observe/tools/__tests__/*.test.ts`).

## Global Constraints

- **Node ≥ 18**, **zero external dependencies** — nothing under `tools/` may `import` a bare package. Node built-ins + ANSI escape codes only. (spec §11)
- **Never open `graph.db`** and never modify observed plugins — the TUI only reads the bus/adapters that already exist. (spec §3, §6)
- **Cross-platform, Windows-primary** — the driver must not assume POSIX-only behavior; guard `stdin.setRawMode`/`isTTY` (may be undefined under pipes/CI). (spec §11)
- **No external TUI library** — raw ANSI only. (spec §9, §11)
- **English only** in all code, comments, docs, commit messages. No mention of any AI tool in code or commits.
- **No version bump / tag / release** as part of this plan — the user releases explicitly and separately (per project memory).
- Renderer/reducer purity: layout functions take `{color}` and default to plain (no ANSI) so snapshots are stable, mirroring `formatLine`/`formatStatus`.

---

## File Structure

New directory `plugins/p-observe/tools/lib/tui/`:

| File | Responsibility |
|---|---|
| `ansi.mjs` | ANSI control constants + `visibleWidth` / `fit` (pad/truncate ignoring escapes). |
| `keys.mjs` | `decodeKeys(str) → token[]` — raw stdin bytes → semantic key tokens. Pure. |
| `derive.mjs` | Derive entity lists from the event buffer + status: `jobsList`, `tasksList`, `pagesList`, `graphHistory`, `overviewRollup`. Pure. |
| `state.mjs` | `initState`, `buildTabs`, `ingest` — TUI state shape + folding live data (events/status/size) and activity badges into it. Pure. |
| `reducer.mjs` | `reduce(state, token) → state` — all key handling (tabs, selection, filter, follow, quit). Pure. |
| `layout/tabbar.mjs` | `renderTabBar(state, width, {color}) → string` with activity badges. Pure. |
| `layout/overview.mjs` | `renderOverview(state, width, height, {color}) → string[]` — rollups + merged stream. Pure. |
| `layout/masterdetail.mjs` | `renderMasterDetail({items, selected, detailLines, width, height, color}) → string[]` generic two-pane. Pure. |
| `layout/plugins.mjs` | Per-plugin bodies: `pshedBody`, `ptasksBody`, `pgraphBody`, `pwikiBody` → `string[]`. Pure. |
| `layout/frame.mjs` | `render(state, {color}) → string[]` — assembles tabbar + body (dispatch by tab) + footer/help. Pure. |
| `driver.mjs` | `runTui(io) → Promise<void>` — impure terminal driver. |

Modified:
- `plugins/p-observe/tools/pobserve.mjs` — add `tui` command + USAGE line.
- `plugins/p-observe/skills/tui/SKILL.md` — new skill (create).
- `plugins/p-observe/skills/help/SKILL.md` — mention `tui`.
- `plugins/p-observe/README.md` — document `pobserve tui` + `/p-observe:tui`.
- `docs/superpowers/specs/2026-07-17-p-observe-design.md` — §8 note reconciling `/p-observe:tui` (watch stays the stream).

Test files (one per module, colocated with existing suites):
- `tools/__tests__/tui-ansi.test.ts`, `tui-keys.test.ts`, `tui-derive.test.ts`, `tui-state.test.ts`, `tui-reducer.test.ts`, `tui-layout.test.ts`, `tui-driver.test.ts`.

### TUI state shape (defined once, used by every task)

```js
// state produced by initState / ingest / reduce
{
  tabs: ['overview', 'p-shed', 'p-tasks', 'p-graph', 'p-wiki'], // overview + detected plugins, fixed order
  tab: 'overview',              // active tab id (member of tabs)
  events: [],                   // last bus.snapshot(), oldest→newest
  status: {},                   // last collectStatus(adapters) snapshot
  selection: {},                // { 'p-shed': idx, 'p-tasks': idx, 'p-wiki': idx } master-detail cursor
  filter: '',                   // applied filter substring (stream + lists)
  filterMode: false,            // true while typing a filter
  filterDraft: '',              // in-progress filter text (committed to filter on Enter)
  follow: true,                 // stream auto-scrolls to newest
  badges: { 'p-shed': 0, 'p-tasks': 0, 'p-graph': 0, 'p-wiki': 0 }, // unread per plugin
  seenTs: 0,                    // ts of newest event already counted for badges
  width: 80, height: 24,
  quit: false,
}
```

### Key tokens (produced by keys.mjs, consumed by reducer.mjs)

`'tab'` (Tab), `'digit:N'` (N = 1..9), `'j'`, `'k'`, `'up'`, `'down'`, `'/'`, `'f'`, `'q'`, `'enter'`, `'esc'`, `'backspace'`, `'char:<c>'` (single printable char), `'ctrl-c'`.

---

## Task 1: ANSI helpers (`ansi.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/ansi.mjs`
- Test: `plugins/p-observe/tools/__tests__/tui-ansi.test.ts`

**Interfaces:**
- Produces:
  - constants `ENTER_ALT, EXIT_ALT, HIDE_CURSOR, SHOW_CURSOR, CLEAR, HOME` (strings)
  - `visibleWidth(str) → number` — length ignoring `\x1b[…m` sequences.
  - `fit(str, width) → string` — pad with spaces (right) or truncate to exactly `width` visible cells, preserving color escapes and appending a reset after a truncation.

- [ ] **Step 1: Write the failing test**

```ts
// tui-ansi.test.ts
import { describe, expect, it } from 'vitest';
import { visibleWidth, fit, HOME, ENTER_ALT } from '../lib/tui/ansi.mjs';

describe('visibleWidth', () => {
  it('ignores ANSI color escapes', () => {
    expect(visibleWidth('\x1b[32mok\x1b[0m')).toBe(2);
    expect(visibleWidth('plain')).toBe(5);
  });
});

describe('fit', () => {
  it('pads short strings to width', () => {
    expect(fit('ab', 5)).toBe('ab   ');
    expect(visibleWidth(fit('ab', 5))).toBe(5);
  });
  it('truncates long plain strings to width', () => {
    expect(fit('abcdef', 4)).toBe('abcd');
  });
  it('truncates colored strings by visible width and resets', () => {
    const out = fit('\x1b[32mabcdef\x1b[0m', 4);
    expect(visibleWidth(out)).toBe(4);
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });
  it('exposes screen control constants', () => {
    expect(HOME).toBe('\x1b[H');
    expect(ENTER_ALT).toContain('1049');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-ansi` (from repo root)
Expected: FAIL — cannot resolve `../lib/tui/ansi.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/ansi.mjs
export const ENTER_ALT = '\x1b[?1049h';
export const EXIT_ALT = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const CLEAR = '\x1b[2J';
export const HOME = '\x1b[H';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleWidth(str) {
  return str.replace(ANSI_RE, '').length;
}

// Pad (right) or truncate `str` to exactly `width` visible cells. Color escapes
// are copied "for free" (don't count toward width); a truncation appends \x1b[0m
// so a cut mid-color never bleeds into the rest of the screen.
export function fit(str, width) {
  if (width <= 0) return '';
  let out = '';
  let seen = 0;
  let colored = false;
  for (let i = 0; i < str.length; ) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; colored = true; i += m[0].length; continue; }
    }
    if (seen >= width) { return out + (colored ? '\x1b[0m' : ''); }
    out += str[i]; seen++; i++;
  }
  if (seen < width) out += ' '.repeat(width - seen);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-ansi`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/ansi.mjs plugins/p-observe/tools/__tests__/tui-ansi.test.ts
git commit -m "feat(p-observe): TUI ansi fit/visibleWidth helpers"
```

---

## Task 2: Key decoder (`keys.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/keys.mjs`
- Test: `plugins/p-observe/tools/__tests__/tui-keys.test.ts`

**Interfaces:**
- Produces: `decodeKeys(str) → token[]` where tokens are the strings listed in "Key tokens" above.

- [ ] **Step 1: Write the failing test**

```ts
// tui-keys.test.ts
import { describe, expect, it } from 'vitest';
import { decodeKeys } from '../lib/tui/keys.mjs';

describe('decodeKeys', () => {
  it('maps simple control keys', () => {
    expect(decodeKeys('\t')).toEqual(['tab']);
    expect(decodeKeys('\r')).toEqual(['enter']);
    expect(decodeKeys('\n')).toEqual(['enter']);
    expect(decodeKeys('\x7f')).toEqual(['backspace']);
    expect(decodeKeys('\x1b')).toEqual(['esc']);
    expect(decodeKeys('\x03')).toEqual(['ctrl-c']);
  });
  it('maps arrow escape sequences', () => {
    expect(decodeKeys('\x1b[A')).toEqual(['up']);
    expect(decodeKeys('\x1b[B')).toEqual(['down']);
  });
  it('maps digits and printable chars', () => {
    expect(decodeKeys('1')).toEqual(['digit:1']);
    expect(decodeKeys('j')).toEqual(['j']);
    expect(decodeKeys('x')).toEqual(['char:x']);
  });
  it('splits multi-key chunks', () => {
    expect(decodeKeys('jk')).toEqual(['j', 'k']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-keys`
Expected: FAIL — cannot resolve `keys.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/keys.mjs
// Decode a raw stdin chunk into semantic key tokens. Arrow-key escape
// sequences arrive as one chunk (\x1b[A); a lone \x1b is Esc.
export function decodeKeys(str) {
  const out = [];
  for (let i = 0; i < str.length; ) {
    const c = str[i];
    if (c === '\x1b') {
      const seq = str.slice(i, i + 3);
      if (seq === '\x1b[A') { out.push('up'); i += 3; continue; }
      if (seq === '\x1b[B') { out.push('down'); i += 3; continue; }
      if (seq === '\x1b[C' || seq === '\x1b[D') { i += 3; continue; } // ignore left/right
      out.push('esc'); i += 1; continue;
    }
    if (c === '\t') { out.push('tab'); i++; continue; }
    if (c === '\r' || c === '\n') { out.push('enter'); i++; continue; }
    if (c === '\x7f' || c === '\b') { out.push('backspace'); i++; continue; }
    if (c === '\x03') { out.push('ctrl-c'); i++; continue; }
    if (c >= '1' && c <= '9') { out.push('digit:' + c); i++; continue; }
    if (c === 'j' || c === 'k' || c === 'f' || c === 'q' || c === '/') { out.push(c); i++; continue; }
    if (c >= ' ' && c <= '~') { out.push('char:' + c); i++; continue; }
    i++; // drop other control bytes
  }
  return out;
}
```

Note: `j/k/f/q//` emit their bare token; every other printable emits `char:<c>` so they can double as filter-mode text. The reducer decides, per mode, whether `j` means "move down" or "type j".

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-keys`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/keys.mjs plugins/p-observe/tools/__tests__/tui-keys.test.ts
git commit -m "feat(p-observe): TUI raw-stdin key decoder"
```

---

## Task 3: Derive entity lists (`derive.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/derive.mjs`
- Test: `plugins/p-observe/tools/__tests__/tui-derive.test.ts`

**Interfaces:**
- Consumes: event objects (§5 shape) and status snapshots (adapter `status()` shapes from `collectStatus`).
- Produces (all pure):
  - `jobsList(events, status) → [{ id, running, lastExit, count }]` sorted failed→running→rest.
  - `tasksList(events) → [{ id, status, history: [{ts, summary}] }]`.
  - `pagesList(events) → [{ id, conflict, count, lastSummary }]`.
  - `graphHistory(events) → [{ ts, summary, severity }]` (p-graph events, newest last).
  - `eventsFor(events, plugin) → event[]` filter helper.

  (Overview rollups reuse the existing `formatStatus` from `lib/render/status.mjs` directly — no dedicated derive function.)

- [ ] **Step 1: Write the failing test**

```ts
// tui-derive.test.ts
import { describe, expect, it } from 'vitest';
import { jobsList, tasksList, pagesList, graphHistory, eventsFor } from '../lib/tui/derive.mjs';

const ev = (o) => ({ ts: 1, plugin: '-', kind: '-', entity: '-', severity: 'info', summary: '', data: {}, ...o });

describe('jobsList', () => {
  it('merges log events with status, sorts failed/running first', () => {
    const events = [
      ev({ plugin: 'p-shed', kind: 'job.finished', entity: 'lint', severity: 'error', summary: 'exit 1' }),
      ev({ plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0' }),
    ];
    const status = { pshed: { running: ['build'], jobs: { lint: { lastExit: 1 }, daily: { lastExit: 0 } } } };
    const list = jobsList(events, status);
    expect(list.map((j) => j.id)).toEqual(['lint', 'build', 'daily']); // failed, running, ok
    expect(list.find((j) => j.id === 'build').running).toBe(true);
  });
});

describe('tasksList', () => {
  it('tracks latest status and history from task events', () => {
    const events = [
      ev({ plugin: 'p-tasks', kind: 'task.added', entity: 'T1', summary: 'added (todo)' }),
      ev({ plugin: 'p-tasks', kind: 'task.status', entity: 'T1', summary: 'todo → done', data: { to: 'done' } }),
    ];
    const list = tasksList(events);
    expect(list[0].id).toBe('T1');
    expect(list[0].status).toBe('done');
    expect(list[0].history).toHaveLength(2);
  });
});

describe('pagesList / graphHistory / eventsFor', () => {
  it('collects wiki pages, graph history, and filters by plugin', () => {
    const events = [
      ev({ plugin: 'p-wiki', kind: 'page.compiled', entity: 'a.md', summary: 'compiled' }),
      ev({ plugin: 'p-wiki', kind: 'wiki.conflict', entity: 'a.md', summary: 'conflict flagged' }),
      ev({ plugin: 'p-graph', kind: 'index.refresh', entity: '-', summary: '+3 nodes' }),
    ];
    expect(pagesList(events)[0]).toMatchObject({ id: 'a.md', conflict: true });
    expect(graphHistory(events)).toHaveLength(1);
    expect(eventsFor(events, 'p-wiki')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-derive`
Expected: FAIL — cannot resolve `derive.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/derive.mjs
export function eventsFor(events, plugin) {
  return events.filter((e) => e.plugin === plugin);
}

// p-shed: union of jobs seen in the log and jobs in status(); sort failed, then
// running, then the rest (stable within each group, alphabetical).
export function jobsList(events, status) {
  const s = status.pshed ?? {};
  const running = new Set(s.running ?? []);
  const jobsMeta = s.jobs ?? {};
  const ids = new Set([...Object.keys(jobsMeta), ...running]);
  for (const e of events) if (e.plugin === 'p-shed' && e.entity !== '-') ids.add(e.entity);
  const list = [...ids].sort().map((id) => ({
    id,
    running: running.has(id),
    lastExit: jobsMeta[id]?.lastExit,
    count: events.filter((e) => e.plugin === 'p-shed' && e.entity === id).length,
  }));
  const rank = (j) => (j.lastExit != null && j.lastExit !== 0 ? 0 : j.running ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}

export function tasksList(events) {
  const map = new Map(); // id -> { id, status, history }
  for (const e of eventsFor(events, 'p-tasks')) {
    if (e.entity === '-') continue;
    let t = map.get(e.entity);
    if (!t) { t = { id: e.entity, status: '?', history: [] }; map.set(e.entity, t); }
    t.history.push({ ts: e.ts, summary: e.summary });
    if (e.kind === 'task.added' && e.data?.status) t.status = e.data.status;
    if (e.kind === 'task.status' && e.data?.to) t.status = e.data.to;
    if (e.kind === 'task.removed') t.status = 'removed';
  }
  return [...map.values()];
}

export function pagesList(events) {
  const map = new Map(); // id -> { id, conflict, count, lastSummary }
  for (const e of eventsFor(events, 'p-wiki')) {
    if (e.entity === '-') continue;
    let p = map.get(e.entity);
    if (!p) { p = { id: e.entity, conflict: false, count: 0, lastSummary: '' }; map.set(e.entity, p); }
    p.count++;
    p.lastSummary = e.summary;
    if (e.kind === 'wiki.conflict') p.conflict = true;
    if (e.kind === 'page.removed') p.conflict = false;
  }
  return [...map.values()];
}

export function graphHistory(events) {
  return eventsFor(events, 'p-graph').map((e) => ({ ts: e.ts, summary: e.summary, severity: e.severity }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-derive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/derive.mjs plugins/p-observe/tools/__tests__/tui-derive.test.ts
git commit -m "feat(p-observe): derive TUI entity lists from event buffer"
```

---

## Task 4: TUI state + ingest (`state.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/state.mjs`
- Test: `plugins/p-observe/tools/__tests__/tui-state.test.ts`

**Interfaces:**
- Consumes: adapter map keys (`pshed|ptasks|pgraph|wiki`), events, status.
- Produces:
  - `PLUGIN_TABS` — ordered `[{ key:'pshed', id:'p-shed' }, …]`.
  - `buildTabs(adapters) → tabIds[]` — `['overview', ...present plugin ids]`.
  - `initState({ tabs, width, height }) → state` (shape above).
  - `ingest(state, { events, status, width, height }) → state` — refresh live data + bump `badges` for plugins whose new events land while their tab is not active (Overview active clears all badges since it shows the merged stream).

- [ ] **Step 1: Write the failing test**

```ts
// tui-state.test.ts
import { describe, expect, it } from 'vitest';
import { buildTabs, initState, ingest } from '../lib/tui/state.mjs';

const ev = (o) => ({ ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'x', severity: 'ok', summary: '', data: {}, ...o });

describe('buildTabs', () => {
  it('lists overview + present plugins in fixed order', () => {
    expect(buildTabs({ pshed: {}, wiki: {} })).toEqual(['overview', 'p-shed', 'p-wiki']);
  });
});

describe('ingest badges', () => {
  it('increments badge for non-active plugin tabs and advances seenTs', () => {
    let s = initState({ tabs: ['overview', 'p-shed', 'p-wiki'], width: 80, height: 24 });
    s.tab = 'p-wiki'; // active tab is p-wiki
    s = ingest(s, { events: [ev({ ts: 10 })], status: {}, width: 80, height: 24 });
    expect(s.badges['p-shed']).toBe(1); // p-shed event, p-shed tab inactive
    expect(s.seenTs).toBe(10);
  });
  it('does not double-count events already seen', () => {
    let s = initState({ tabs: ['overview', 'p-shed'], width: 80, height: 24 });
    s.tab = 'overview';
    const e = ev({ ts: 5 });
    s = ingest(s, { events: [e], status: {}, width: 80, height: 24 });
    s = ingest(s, { events: [e], status: {}, width: 80, height: 24 });
    // overview is active -> merged stream shows everything -> no badge accrues
    expect(s.badges['p-shed']).toBe(0);
    expect(s.seenTs).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-state`
Expected: FAIL — cannot resolve `state.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/state.mjs
export const PLUGIN_TABS = [
  { key: 'pshed', id: 'p-shed' },
  { key: 'ptasks', id: 'p-tasks' },
  { key: 'pgraph', id: 'p-graph' },
  { key: 'wiki', id: 'p-wiki' },
];

export function buildTabs(adapters) {
  const present = PLUGIN_TABS.filter((t) => adapters[t.key]).map((t) => t.id);
  return ['overview', ...present];
}

export function initState({ tabs, width = 80, height = 24 }) {
  return {
    tabs,
    tab: tabs[0] ?? 'overview',
    events: [],
    status: {},
    selection: {},
    filter: '',
    filterMode: false,
    filterDraft: '',
    follow: true,
    badges: { 'p-shed': 0, 'p-tasks': 0, 'p-graph': 0, 'p-wiki': 0 },
    seenTs: 0,
    width,
    height,
    quit: false,
  };
}

// Fold the latest bus snapshot + status + terminal size into state. Events newer
// than seenTs that belong to a plugin whose tab is NOT currently active bump that
// plugin's badge; Overview counts as "showing everything" and clears all badges.
export function ingest(state, { events, status, width, height }) {
  const badges = { ...state.badges };
  let maxTs = state.seenTs;
  if (state.tab === 'overview') {
    for (const k of Object.keys(badges)) badges[k] = 0;
  }
  for (const e of events) {
    if (e.ts <= state.seenTs) continue;
    if (e.ts > maxTs) maxTs = e.ts;
    if (state.tab !== 'overview' && e.plugin !== state.tab && badges[e.plugin] != null) {
      badges[e.plugin] += 1;
    }
  }
  return { ...state, events, status, width, height, badges, seenTs: maxTs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/state.mjs plugins/p-observe/tools/__tests__/tui-state.test.ts
git commit -m "feat(p-observe): TUI state + live ingest with activity badges"
```

---

## Task 5: Key reducer (`reducer.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/reducer.mjs`
- Test: `plugins/p-observe/tools/__tests__/tui-reducer.test.ts`

**Interfaces:**
- Consumes: state (from `initState`/`ingest`), token strings (from `decodeKeys`), `derive.mjs` list functions to bound selection.
- Produces: `reduce(state, token) → state`. Switching to a plugin tab clears that plugin's badge. `q`/`ctrl-c` set `quit:true`. In `filterMode`, printable tokens edit `filterDraft`; Enter commits to `filter`; Esc cancels.

- [ ] **Step 1: Write the failing test**

```ts
// tui-reducer.test.ts
import { describe, expect, it } from 'vitest';
import { initState } from '../lib/tui/state.mjs';
import { reduce } from '../lib/tui/reducer.mjs';

function base() {
  const s = initState({ tabs: ['overview', 'p-shed', 'p-wiki'], width: 80, height: 24 });
  s.badges['p-shed'] = 3;
  return s;
}

describe('reduce', () => {
  it('Tab cycles tabs and clears the target badge', () => {
    let s = reduce(base(), 'tab');
    expect(s.tab).toBe('p-shed');
    expect(s.badges['p-shed']).toBe(0);
  });
  it('digit jumps to a tab by 1-based index', () => {
    expect(reduce(base(), 'digit:2').tab).toBe('p-shed');
    expect(reduce(base(), 'digit:9').tab).toBe('overview'); // out of range -> no change
  });
  it('q and ctrl-c quit', () => {
    expect(reduce(base(), 'q').quit).toBe(true);
    expect(reduce(base(), 'ctrl-c').quit).toBe(true);
  });
  it('f toggles follow', () => {
    expect(reduce(base(), 'f').follow).toBe(false);
  });
  it('/ enters filter mode; chars edit draft; enter commits; esc cancels', () => {
    let s = reduce(base(), '/');
    expect(s.filterMode).toBe(true);
    s = reduce(s, 'char:a');
    s = reduce(s, 'j'); // in filter mode j is literal text
    expect(s.filterDraft).toBe('aj');
    s = reduce(s, 'backspace');
    expect(s.filterDraft).toBe('a');
    s = reduce(s, 'enter');
    expect(s.filterMode).toBe(false);
    expect(s.filter).toBe('a');
    s = reduce(reduce(s, '/'), 'esc');
    expect(s.filterMode).toBe(false);
    expect(s.filter).toBe('a'); // unchanged on cancel
  });
  it('j/k move selection on plugin tabs only', () => {
    let s = base(); s.tab = 'p-shed';
    s = reduce(s, 'j');
    expect(s.selection['p-shed']).toBe(1);
    s = reduce(s, 'k'); s = reduce(s, 'k');
    expect(s.selection['p-shed']).toBe(0); // clamped at 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-reducer`
Expected: FAIL — cannot resolve `reducer.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/reducer.mjs
function switchTab(state, id) {
  if (!state.tabs.includes(id)) return state;
  const badges = { ...state.badges };
  if (badges[id] != null) badges[id] = 0;
  return { ...state, tab: id, badges };
}

function moveSelection(state, delta) {
  if (state.tab === 'overview') return state;
  const cur = state.selection[state.tab] ?? 0;
  const next = Math.max(0, cur + delta); // upper bound is clamped at render time against list length
  return { ...state, selection: { ...state.selection, [state.tab]: next } };
}

export function reduce(state, token) {
  if (state.filterMode) {
    if (token === 'enter') return { ...state, filterMode: false, filter: state.filterDraft };
    if (token === 'esc') return { ...state, filterMode: false, filterDraft: state.filter };
    if (token === 'backspace') return { ...state, filterDraft: state.filterDraft.slice(0, -1) };
    if (token.startsWith('char:')) return { ...state, filterDraft: state.filterDraft + token.slice(5) };
    // bare j/k/f/q// are literal text while typing a filter
    if (['j', 'k', 'f', 'q', '/'].includes(token)) return { ...state, filterDraft: state.filterDraft + token };
    return state;
  }
  if (token === 'q' || token === 'ctrl-c') return { ...state, quit: true };
  if (token === 'tab') {
    const i = state.tabs.indexOf(state.tab);
    return switchTab(state, state.tabs[(i + 1) % state.tabs.length]);
  }
  if (token.startsWith('digit:')) {
    const idx = Number(token.slice(6)) - 1;
    return idx >= 0 && idx < state.tabs.length ? switchTab(state, state.tabs[idx]) : state;
  }
  if (token === 'f') return { ...state, follow: !state.follow };
  if (token === '/') return { ...state, filterMode: true, filterDraft: state.filter };
  if (token === 'j' || token === 'down') return moveSelection(state, +1);
  if (token === 'k' || token === 'up') return moveSelection(state, -1);
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-reducer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/reducer.mjs plugins/p-observe/tools/__tests__/tui-reducer.test.ts
git commit -m "feat(p-observe): TUI key reducer (tabs, selection, filter, follow, quit)"
```

---

## Task 6: Tab bar layout (`layout/tabbar.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/layout/tabbar.mjs`
- Test: extend `plugins/p-observe/tools/__tests__/tui-layout.test.ts` (create in this task)

**Interfaces:**
- Consumes: state, width, `{color}`, `ansi.fit`.
- Produces: `renderTabBar(state, width, {color}) → string` — one line; active tab bracketed, inactive tabs show `●N` badge when `badges[id] > 0`.

- [ ] **Step 1: Write the failing test**

```ts
// tui-layout.test.ts
import { describe, expect, it } from 'vitest';
import { renderTabBar } from '../lib/tui/layout/tabbar.mjs';
import { initState } from '../lib/tui/state.mjs';

function st() {
  const s = initState({ tabs: ['overview', 'p-shed', 'p-wiki'], width: 60, height: 20 });
  s.badges['p-wiki'] = 2;
  return s;
}

describe('renderTabBar', () => {
  it('brackets the active tab and shows badges on others', () => {
    const bar = renderTabBar(st(), 60, { color: false });
    expect(bar).toContain('[1 overview]'); // active by default
    expect(bar).toContain('2 p-shed');
    expect(bar).toMatch(/p-wiki ●2|●2 p-wiki|p-wiki.*2/);
  });
  it('pads to the given width', () => {
    expect(renderTabBar(st(), 60, { color: false }).length).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-layout`
Expected: FAIL — cannot resolve `tabbar.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/layout/tabbar.mjs
import { fit } from '../ansi.mjs';

export function renderTabBar(state, width, { color = false } = {}) {
  const parts = state.tabs.map((id, i) => {
    const n = i + 1;
    const badge = state.badges[id] > 0 ? ` ●${state.badges[id]}` : '';
    const label = `${n} ${id}${badge}`;
    if (id === state.tab) return color ? `\x1b[7m[${label}]\x1b[0m` : `[${label}]`;
    return ` ${label} `;
  });
  return fit(parts.join(' '), width);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-layout`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/tabbar.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): TUI tab bar with activity badges"
```

---

## Task 7: Overview layout (`layout/overview.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/layout/overview.mjs`
- Test: extend `tui-layout.test.ts`

**Interfaces:**
- Consumes: state, width, height, `{color}`; reuses `formatStatus` (`lib/render/status.mjs`) for rollups and `formatLine` (`lib/render/stream.mjs`) for stream lines; `applyFilter` (below).
- Produces: `renderOverview(state, width, height, {color}) → string[]` — top rollups block, a divider, then the last events (filtered by `state.filter`), newest at the bottom when `follow`.

- [ ] **Step 1: Write the failing test**

```ts
// add to tui-layout.test.ts
import { renderOverview } from '../lib/tui/layout/overview.mjs';

const ev = (o) => ({ ts: Date.parse('2026-07-18T10:00:00Z'), plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0', data: {}, ...o });

describe('renderOverview', () => {
  it('shows rollups and the merged stream, height-bounded', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 60, height: 10 });
    s.status = { pshed: { running: [], jobs: { daily: { lastExit: 0 } } } };
    s.events = [ev({ summary: 'exit 0' }), ev({ entity: 'lint', severity: 'error', summary: 'exit 1' })];
    const lines = renderOverview(s, 60, 10, { color: false });
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.join('\n')).toContain('p-shed');
    expect(lines.join('\n')).toContain('exit 1');
  });
  it('applies the filter to the stream', () => {
    const s = initState({ tabs: ['overview'], width: 60, height: 10 });
    s.events = [ev({ summary: 'exit 0' }), ev({ entity: 'lint', summary: 'exit 1' })];
    s.filter = 'lint';
    const body = renderOverview(s, 60, 10, { color: false }).join('\n');
    expect(body).toContain('lint');
    expect(body).not.toContain('daily');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-layout`
Expected: FAIL — cannot resolve `overview.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/layout/overview.mjs
import { fit } from '../ansi.mjs';
import { formatStatus } from '../../render/status.mjs';
import { formatLine } from '../../render/stream.mjs';

// Shared filter predicate used by overview and per-plugin bodies: case-insensitive
// substring over the rendered plain line (entity + summary + plugin).
export function applyFilter(events, filter) {
  if (!filter) return events;
  const f = filter.toLowerCase();
  return events.filter((e) => `${e.plugin} ${e.entity} ${e.summary}`.toLowerCase().includes(f));
}

export function renderOverview(state, width, height, { color = false } = {}) {
  const lines = [];
  const roll = formatStatus(state.status);
  if (roll) for (const l of roll.split('\n')) lines.push(fit(l, width));
  lines.push(fit('─'.repeat(width), width));
  const streamHeight = Math.max(1, height - lines.length);
  let stream = applyFilter(state.events, state.filter).map((e) => fit(formatLine(e, { color }), width));
  stream = stream.slice(-streamHeight); // tail: newest at the bottom
  for (const l of stream) lines.push(l);
  return lines.slice(0, height);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-layout`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/overview.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): TUI overview (rollups + filtered merged stream)"
```

---

## Task 8: Master-detail + per-plugin bodies (`layout/masterdetail.mjs`, `layout/plugins.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/layout/masterdetail.mjs`
- Create: `plugins/p-observe/tools/lib/tui/layout/plugins.mjs`
- Test: extend `tui-layout.test.ts`

**Interfaces:**
- `renderMasterDetail({ items, selectedIdx, detailLines, width, height, color }) → string[]` — left list (items, cursor highlighted), right detail pane, split ~40/60, height-bounded, selection clamped into range.
- `pshedBody(state, w, h, {color})`, `ptasksBody(...)`, `pgraphBody(...)`, `pwikiBody(...)` → `string[]`. p-graph has no list (single entity) → counters + reindex history.

- [ ] **Step 1: Write the failing test**

```ts
// add to tui-layout.test.ts
import { renderMasterDetail } from '../lib/tui/layout/masterdetail.mjs';
import { pshedBody, pgraphBody } from '../lib/tui/layout/plugins.mjs';

describe('renderMasterDetail', () => {
  it('renders list + detail, marks the selected row, clamps selection', () => {
    const out = renderMasterDetail({
      items: ['a', 'b', 'c'], selectedIdx: 99, detailLines: ['detail'], width: 40, height: 5, color: false,
    });
    expect(out).toHaveLength(5);
    expect(out.join('\n')).toContain('c'); // clamp to last
    expect(out.join('\n')).toContain('detail');
    expect(out.some((l) => l.includes('>'))).toBe(true); // cursor marker
  });
});

describe('per-plugin bodies', () => {
  it('pshedBody lists jobs and shows the selected job detail', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 60, height: 8 });
    s.tab = 'p-shed';
    s.status = { pshed: { running: ['build'], jobs: { lint: { lastExit: 1 } } } };
    s.events = [ev({ plugin: 'p-shed', entity: 'lint', severity: 'error', summary: 'exit 1' })];
    const out = pshedBody(s, 60, 8, { color: false });
    expect(out.join('\n')).toContain('lint');
    expect(out.join('\n')).toContain('build');
  });
  it('pgraphBody shows counters and reindex history (no list)', () => {
    const s = initState({ tabs: ['overview', 'p-graph'], width: 60, height: 8 });
    s.tab = 'p-graph';
    s.status = { pgraph: { nodes: 120, drift: 0 } };
    s.events = [ev({ plugin: 'p-graph', entity: '-', summary: '+3 nodes (120 total)' })];
    const out = pgraphBody(s, 60, 8, { color: false });
    expect(out.join('\n')).toContain('120');
    expect(out.join('\n')).toContain('nodes');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-layout`
Expected: FAIL — cannot resolve `masterdetail.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/layout/masterdetail.mjs
import { fit } from '../ansi.mjs';

export function clampIdx(idx, len) {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(idx, len - 1));
}

export function renderMasterDetail({ items, selectedIdx, detailLines, width, height, color = false }) {
  const listW = Math.max(12, Math.floor(width * 0.4));
  const detailW = width - listW - 1;
  const sel = clampIdx(selectedIdx, items.length);
  // window the list around the selection so a long list still shows the cursor
  const start = Math.max(0, Math.min(sel - Math.floor(height / 2), Math.max(0, items.length - height)));
  const rows = [];
  for (let i = 0; i < height; i++) {
    const idx = start + i;
    let left = '';
    if (idx < items.length) {
      const marker = idx === sel ? '>' : ' ';
      const row = `${marker} ${items[idx]}`;
      left = color && idx === sel ? `\x1b[7m${fit(row, listW)}\x1b[0m` : fit(row, listW);
    } else {
      left = fit('', listW);
    }
    const right = fit(detailLines[i] ?? '', detailW);
    rows.push(left + '│' + right);
  }
  return rows;
}
```

```js
// plugins/p-observe/tools/lib/tui/layout/plugins.mjs
import { fit } from '../ansi.mjs';
import { formatLine } from '../../render/stream.mjs';
import { renderMasterDetail, clampIdx } from './masterdetail.mjs';
import { jobsList, tasksList, pagesList, graphHistory, eventsFor } from '../derive.mjs';

function jobLabel(j) {
  const tag = j.running ? '⟳' : j.lastExit != null && j.lastExit !== 0 ? '✗' : '·';
  return `${tag} ${j.id}`;
}

export function pshedBody(state, width, height, { color = false } = {}) {
  const jobs = applyFilterList(jobsList(state.events, state.status), state.filter, (j) => j.id);
  const sel = clampIdx(state.selection['p-shed'] ?? 0, jobs.length);
  const chosen = jobs[sel];
  const detail = [];
  if (chosen) {
    detail.push(fit(`job: ${chosen.id}`, width));
    detail.push(fit(`state: ${chosen.running ? 'running' : chosen.lastExit != null ? 'exit ' + chosen.lastExit : '—'}`, width));
    detail.push('');
    for (const e of eventsFor(state.events, 'p-shed').filter((e) => e.entity === chosen.id))
      detail.push(formatLine(e, { color }));
  }
  return renderMasterDetail({ items: jobs.map(jobLabel), selectedIdx: sel, detailLines: detail, width, height, color });
}

export function ptasksBody(state, width, height, { color = false } = {}) {
  const tasks = applyFilterList(tasksList(state.events), state.filter, (t) => t.id + ' ' + t.status);
  const sel = clampIdx(state.selection['p-tasks'] ?? 0, tasks.length);
  const chosen = tasks[sel];
  const detail = [];
  if (chosen) {
    detail.push(fit(`task: ${chosen.id}  [${chosen.status}]`, width));
    detail.push('');
    for (const h of chosen.history) detail.push(fit(`  ${h.summary}`, width));
  }
  return renderMasterDetail({ items: tasks.map((t) => `${t.id} (${t.status})`), selectedIdx: sel, detailLines: detail, width, height, color });
}

export function pwikiBody(state, width, height, { color = false } = {}) {
  const pages = applyFilterList(pagesList(state.events), state.filter, (p) => p.id);
  const sel = clampIdx(state.selection['p-wiki'] ?? 0, pages.length);
  const chosen = pages[sel];
  const detail = [];
  if (chosen) {
    detail.push(fit(`page: ${chosen.id}${chosen.conflict ? '  ⚠ conflict' : ''}`, width));
    detail.push('');
    for (const e of eventsFor(state.events, 'p-wiki').filter((e) => e.entity === chosen.id))
      detail.push(formatLine(e, { color }));
  }
  return renderMasterDetail({ items: pages.map((p) => (p.conflict ? '⚠ ' : '  ') + p.id), selectedIdx: sel, detailLines: detail, width, height, color });
}

// p-graph is single-entity: no master list, just counters + reindex history.
export function pgraphBody(state, width, height, { color = false } = {}) {
  const g = state.status.pgraph ?? {};
  const lines = [];
  lines.push(fit(`nodes ${g.nodes ?? '?'} · edges ${g.edges ?? '?'} · files ${g.files ?? '?'} · drift ${g.drift ?? '?'}`, width));
  lines.push(fit('─'.repeat(width), width));
  const hist = applyFilterList(graphHistory(state.events), state.filter, (h) => h.summary);
  for (const h of hist.slice(-(height - 2))) lines.push(fit(`  ${h.summary}`, width));
  return lines.slice(0, height);
}

function applyFilterList(items, filter, textOf) {
  if (!filter) return items;
  const f = filter.toLowerCase();
  return items.filter((it) => textOf(it).toLowerCase().includes(f));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-layout`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/masterdetail.mjs plugins/p-observe/tools/lib/tui/layout/plugins.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): TUI master-detail + per-plugin bodies"
```

---

## Task 9: Frame assembly (`layout/frame.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/layout/frame.mjs`
- Test: extend `tui-layout.test.ts`

**Interfaces:**
- Consumes: state, `{color}`, `renderTabBar`, `renderOverview`, per-plugin bodies.
- Produces: `render(state, {color}) → string[]` — exactly `state.height` lines: row 0 tab bar, last row footer/help (or filter prompt when `filterMode`), middle rows the active tab body.

- [ ] **Step 1: Write the failing test**

```ts
// add to tui-layout.test.ts
import { render } from '../lib/tui/layout/frame.mjs';

describe('render (frame)', () => {
  it('produces exactly height lines with tab bar and footer', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 50, height: 12 });
    s.status = { pshed: { running: [], jobs: {} } };
    const out = render(s, { color: false });
    expect(out).toHaveLength(12);
    expect(out[0]).toContain('overview');
    expect(out[11]).toMatch(/q quit|filter/i);
  });
  it('shows the filter prompt in the footer while typing', () => {
    const s = initState({ tabs: ['overview'], width: 50, height: 8 });
    s.filterMode = true; s.filterDraft = 'lin';
    const out = render(s, { color: false });
    expect(out[out.length - 1]).toContain('/lin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-layout`
Expected: FAIL — cannot resolve `frame.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/layout/frame.mjs
import { fit } from '../ansi.mjs';
import { renderTabBar } from './tabbar.mjs';
import { renderOverview } from './overview.mjs';
import { pshedBody, ptasksBody, pgraphBody, pwikiBody } from './plugins.mjs';

const BODY = {
  'p-shed': pshedBody,
  'p-tasks': ptasksBody,
  'p-graph': pgraphBody,
  'p-wiki': pwikiBody,
};

function footer(state, width) {
  if (state.filterMode) return fit(`/${state.filterDraft}▏  (Enter apply · Esc cancel)`, width);
  const flt = state.filter ? `  filter:${state.filter}` : '';
  const foll = state.follow ? 'follow' : 'paused';
  return fit(`Tab/1-9 tabs · j/k move · / filter · f ${foll} · q quit${flt}`, width);
}

export function render(state, { color = false } = {}) {
  const { width, height } = state;
  const bodyHeight = Math.max(1, height - 2); // tab bar + footer
  const lines = [renderTabBar(state, width, { color })];
  const body = state.tab === 'overview'
    ? renderOverview(state, width, bodyHeight, { color })
    : (BODY[state.tab] ?? renderOverview)(state, width, bodyHeight, { color });
  for (let i = 0; i < bodyHeight; i++) lines.push(body[i] ?? fit('', width));
  lines.push(footer(state, width));
  return lines.slice(0, height);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-layout`
Expected: PASS (all tui-layout cases).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/layout/frame.mjs plugins/p-observe/tools/__tests__/tui-layout.test.ts
git commit -m "feat(p-observe): TUI frame assembly (tab bar + body + footer)"
```

---

## Task 10: Terminal driver (`driver.mjs`)

**Files:**
- Create: `plugins/p-observe/tools/lib/tui/driver.mjs`
- Test: `plugins/p-observe/tools/__tests__/tui-driver.test.ts`

**Interfaces:**
- Consumes: bus (`subscribe`/`snapshot`), `collectStatus` from `lib/core.mjs`, adapters, injected `stdin`/`stdout`/`size` for tests, `initState`/`ingest`/`reduce`/`render`/`decodeKeys`.
- Produces: `runTui(io) → Promise<void>` where `io = { bus, adapters, stdin, stdout, size?, color? }`. Resolves when the user quits. Enters alt-screen, sets raw mode (guarded), paints on bus events (throttled to next tick) and on key input, repaints on `resize`, restores the terminal on teardown.

- [ ] **Step 1: Write the failing test**

```ts
// tui-driver.test.ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { runTui } from '../lib/tui/driver.mjs';
import { createBus } from '../lib/bus.mjs';

function fakeIO() {
  const stdin = new EventEmitter();
  stdin.setRawMode = () => {}; // guarded feature present
  stdin.resume = () => {};
  stdin.pause = () => {};
  const writes = [];
  const stdout = new EventEmitter();
  stdout.write = (s) => { writes.push(s); return true; };
  stdout.columns = 60; stdout.rows = 12;
  return { stdin, stdout, writes };
}

describe('runTui', () => {
  it('paints on start and resolves when q is pressed', async () => {
    const { stdin, stdout, writes } = fakeIO();
    const bus = createBus({ size: 100 });
    const adapters = { pshed: { status: () => ({ running: [], jobs: {} }) } };
    const done = runTui({ bus, adapters, stdin, stdout, size: { width: 60, height: 12 }, color: false });
    expect(writes.join('')).toContain('overview'); // initial paint
    stdin.emit('data', Buffer.from('q'));
    await done; // resolves
    expect(writes.join('')).toContain('\x1b[?1049l'); // exited alt screen on teardown
  });

  it('repaints when a bus event arrives', async () => {
    const { stdin, stdout, writes } = fakeIO();
    const bus = createBus({ size: 100 });
    const adapters = { pshed: { status: () => ({ running: [], jobs: {} }) } };
    const done = runTui({ bus, adapters, stdin, stdout, size: { width: 60, height: 12 }, color: false });
    const before = writes.length;
    bus.push({ ts: 2, plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0', data: {} });
    await new Promise((r) => setImmediate(r)); // let the throttled paint flush
    expect(writes.length).toBeGreaterThan(before);
    stdin.emit('data', Buffer.from('q'));
    await done;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tui-driver`
Expected: FAIL — cannot resolve `driver.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// plugins/p-observe/tools/lib/tui/driver.mjs
import { collectStatus } from '../core.mjs';
import { ENTER_ALT, EXIT_ALT, HIDE_CURSOR, SHOW_CURSOR, HOME, CLEAR } from './ansi.mjs';
import { buildTabs, initState, ingest } from './state.mjs';
import { reduce } from './reducer.mjs';
import { decodeKeys } from './keys.mjs';
import { render } from './layout/frame.mjs';

export function runTui(io) {
  const { bus, adapters, stdin, stdout, color = true } = io;
  let size = io.size ?? { width: stdout.columns || 80, height: stdout.rows || 24 };
  let state = initState({ tabs: buildTabs(adapters), width: size.width, height: size.height });
  let scheduled = false;
  let unsub = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  function paint() {
    scheduled = false;
    state = ingest(state, {
      events: bus.snapshot(),
      status: collectStatus(adapters),
      width: size.width,
      height: size.height,
    });
    stdout.write(HOME + render(state, { color }).join('\n'));
  }
  function schedule() { if (!scheduled) { scheduled = true; setImmediate(paint); } }

  function onData(chunk) {
    for (const tok of decodeKeys(chunk.toString('utf-8'))) {
      state = reduce(state, tok);
      if (state.quit) { teardown(); resolveDone(); return; }
    }
    paint();
  }
  function onResize() {
    size = { width: stdout.columns || size.width, height: stdout.rows || size.height };
    paint();
  }

  let torn = false;
  function teardown() {
    if (torn) return; torn = true;
    if (unsub) unsub();
    stdin.removeListener('data', onData);
    if (stdout.removeListener) stdout.removeListener('resize', onResize);
    try { if (stdin.setRawMode) stdin.setRawMode(false); } catch { /* not a TTY */ }
    if (stdin.pause) stdin.pause();
    stdout.write(SHOW_CURSOR + EXIT_ALT);
  }

  // setup
  try { if (stdin.setRawMode) stdin.setRawMode(true); } catch { /* not a TTY */ }
  if (stdin.resume) stdin.resume();
  stdout.write(ENTER_ALT + HIDE_CURSOR + CLEAR);
  stdin.on('data', onData);
  if (stdout.on) stdout.on('resize', onResize);
  unsub = bus.subscribe(schedule);
  paint();

  return done;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tui-driver`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-observe/tools/lib/tui/driver.mjs plugins/p-observe/tools/__tests__/tui-driver.test.ts
git commit -m "feat(p-observe): TUI terminal driver (alt-screen, raw stdin, throttled paint)"
```

---

## Task 11: Wire the `tui` command (`pobserve.mjs`)

**Files:**
- Modify: `plugins/p-observe/tools/pobserve.mjs` (USAGE, `KNOWN`, new branch)
- Test: `plugins/p-observe/tools/__tests__/cli-entry.test.ts` (extend — confirm `tui` is a known command; assert it is dispatched, using a stub so no real TTY is needed)

First inspect the existing entry test to match its style:

```bash
sed -n '1,60p' plugins/p-observe/tools/__tests__/cli-entry.test.ts
```

**Interfaces:**
- Consumes: existing `assemble`, `createBus`, `runBackfill`, `startAll`, `stopAll`, journal helpers; new `runTui`.
- Produces: `pobserve tui` — builds bus + adapters (same path as `watch`), backfills, starts adapters, runs the TUI, and on quit stops adapters and exits 0. Honors `--journal`/`cfg.journal` exactly like `watch`.

- [ ] **Step 1: Write the failing test**

Add to `cli-entry.test.ts` (adapt imports to the file's existing pattern — it imports the module's `main`/default). If `cli-entry.test.ts` tests the parsed command set, assert `'tui'` is accepted:

```ts
// in cli-entry.test.ts — assert 'tui' is a recognized command (not "unknown")
import { KNOWN } from '../pobserve.mjs'; // export KNOWN in the impl step below
import { describe, expect, it } from 'vitest';

describe('cli commands', () => {
  it('recognizes tui', () => {
    expect(KNOWN.has('tui')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cli-entry`
Expected: FAIL — `KNOWN` is not exported / does not include `tui`.

- [ ] **Step 3: Write minimal implementation**

In `pobserve.mjs`:

1. Add the import near the other renderer imports:

```js
import { runTui } from './lib/tui/driver.mjs';
```

2. Export `KNOWN` and add `tui`:

```js
export const KNOWN = new Set(['watch', 'status', 'capture', 'tui', 'help']);
```

3. Add a USAGE line under Commands:

```
  pobserve tui       k9s-style TUI: tabs + per-plugin master-detail
```

4. After the `status` early-return and after the bus/adapters/journal setup block (i.e. after the `if (journalOn) rotateJournal(...)` line, alongside the `watch`/`capture` handling), add the `tui` branch. Place it before `runBackfill` so backfilled history is in the buffer before the first paint, and gate the stream subscriber on `watch` only:

```js
  if (command === 'tui') {
    runBackfill(adapters, { paths, cfg, emit: bus.push });
    if (journalOn) {
      bus.subscribe((e) => {
        try { appendJournal(paths.journalDir, e, Date.now()); }
        catch (err) { process.stderr.write('pobserve: journal write failed: ' + err.message + '\n'); }
      });
    }
    startAll(adapters);
    await runTui({ bus, adapters, stdin: process.stdin, stdout: process.stdout, color: process.stdout.isTTY });
    stopAll(adapters);
    return 0;
  }
```

Ensure this branch returns before the existing `watch`/`capture` subscriber and `await new Promise(SIGINT…)` block so the two paths don't both run. (Concretely: wrap the existing `watch`/`capture` tail in `if (command !== 'tui')`, or `return` from the `tui` branch as shown — the `return 0` already prevents fall-through.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cli-entry`
Expected: PASS.

Then a manual smoke check (interactive; not part of CI):

```bash
cd <a repo with .pshed/ or docs/tasks/tasks.yml>
node "<path>/plugins/p-observe/tools/pobserve.mjs" tui
# expect: alt-screen TUI; Tab switches tabs; q restores the terminal cleanly
```

- [ ] **Step 5: Run the full suite + commit**

Run: `npm test` (from repo root)
Expected: PASS (all p-observe suites, including the new tui-* files).

```bash
git add plugins/p-observe/tools/pobserve.mjs plugins/p-observe/tools/__tests__/cli-entry.test.ts
git commit -m "feat(p-observe): wire pobserve tui command"
```

---

## Task 12: Skill + docs (`/p-observe:tui`, README, help, spec note)

**Files:**
- Create: `plugins/p-observe/skills/tui/SKILL.md`
- Modify: `plugins/p-observe/skills/help/SKILL.md`
- Modify: `plugins/p-observe/README.md`
- Modify: `docs/superpowers/specs/2026-07-17-p-observe-design.md` (§8 reconciliation note)

**Interfaces:** docs only — no code contract.

- [ ] **Step 1: Create the `/p-observe:tui` skill**

```markdown
---
name: tui
description: Launch the p-observe k9s-style TUI for the current repo — tabbed overview + per-plugin master-detail. Use when the user says "open the TUI", "p-observe dashboard", "show the observer UI", or "tui".
---

# /p-observe:tui

Launch the interactive TUI. This is a long-running foreground process that takes
over the terminal (alternate screen) — tell the user to press `q` to quit.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" tui
```

Keys: `Tab`/`1`-`9` switch tabs · `j`/`k` (or ↑/↓) move selection · `/` filter ·
`f` toggle follow · `q` quit.

Options:
- `--journal` — also persist events to per-day journal files in `.pobserve/`.

For the plain line stream instead (pipeable, no alt-screen), use `/p-observe:watch`.
For "what happened while I was away", keep `pobserve capture` running so a later `tui`
backfills the full timeline from the journal.
```

- [ ] **Step 2: Update the help skill**

Open `plugins/p-observe/skills/help/SKILL.md` and add a `tui` row/line alongside `watch`/`status`/`capture`, e.g.:

```
- `pobserve tui` — k9s-style TUI: tabs + per-plugin master-detail (`/`, `f`, `j/k`, `q`).
```

(Match the file's existing list format.)

- [ ] **Step 3: Update the README**

In `plugins/p-observe/README.md`, add to the Commands table:

```
| `pobserve tui` | Interactive k9s-style TUI: Overview + per-plugin master-detail tabs. |
```

and to the Skills table:

```
| `/p-observe:tui` | Launch the interactive TUI. |
```

- [ ] **Step 4: Reconcile the spec (§8)**

In `docs/superpowers/specs/2026-07-17-p-observe-design.md` §8, update the skills list so it matches what shipped: `/p-observe:watch` launches the **stream** (phase 1), and add `/p-observe:tui` launching the TUI (phase 2). Replace the `/p-observe:watch — launch the TUI` line with:

```
- `/p-observe:watch` — launch the live line stream (`pobserve watch`).
- `/p-observe:tui` — launch the k9s-style TUI (`pobserve tui`).
```

- [ ] **Step 5: Validate structure + commit**

Run: `npm run validate` (repo plugin/skill structure check) and `npm test`
Expected: PASS.

```bash
git add plugins/p-observe/skills/tui/SKILL.md plugins/p-observe/skills/help/SKILL.md plugins/p-observe/README.md docs/superpowers/specs/2026-07-17-p-observe-design.md
git commit -m "docs(p-observe): /p-observe:tui skill, README, help, spec reconciliation"
```

---

## Self-Review

**Spec coverage (§9 UI):**
- Stream zone (chronological, colored, filterable) → Task 7 (overview) + `applyFilter`.
- Status zone rollups → Task 7 reuses `formatStatus`.
- Overview tab (rollups + merged stream) → Task 7.
- Per-plugin master-detail (p-shed jobs, p-tasks tasks, p-wiki pages, p-graph counters+history) → Task 8.
- Activity badges on tab headers → Task 4 (`ingest`) + Task 6 (`renderTabBar`).
- Keys `Tab`/digits/`j`/`k`/`/`/`f`/`q` → Task 2 (decode) + Task 5 (reduce); footer help → Task 9.
- Raw ANSI, no TUI lib → Task 1 + all layout tasks.
- §12 testing: pure `state → string[]` layout (Tasks 6-9), reducer `(state, key) → state` (Task 5), snapshot-style assertions without a real terminal (all layout tests); driver tested with fake stdin/stdout (Task 10).
- Backfill so Overview isn't empty (§10) → Task 11 calls `runBackfill` before the first paint.
- Journal opt-in under `tui` (§10) → Task 11 `--journal` handling.

**Decisions applied:** `/p-observe:tui` added; `pobserve watch` + `/p-observe:watch` unchanged (Task 12, spec §8 reconciled). Full §9 in one plan.

**Placeholder scan:** No TBD/TODO; every code step has real code. The one prose caveat in Task 8 (pgraphBody) resolves to a concrete simplified function that is the version to implement.

**Type consistency:** `initState`/`ingest`/`reduce` operate on the single documented state shape. `render(state,{color})→string[]`, body fns `(state,w,h,{color})→string[]`, `fit(str,width)→string`, `decodeKeys(str)→token[]`, derive fns return the shapes consumed by plugins.mjs. `KNOWN` exported for the entry test. Driver `io` shape matches the driver test's fake.

**No release actions** — per project memory, no version bump/tag; the user releases separately.
```

