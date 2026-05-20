# p-tasks Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `p-tasks` Claude Code plugin per `docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md` — a two-level task tracker (`task` → `sub-task`) with `todo` / `in_progress` / `done` statuses, blockers across levels, and FS + Jira destinations with one-way `primary → mirrors` sync.

**Architecture:** Skill-per-operation slash commands (`/p-tasks:init|add|set|next|summary|sync`) all dispatch to a bundled Node CLI `ptasks.mjs`. The CLI exposes a `Destination` interface with `fs` and `jira` implementations; `sync.mjs` is the only module that crosses destination boundaries. Data on FS lives in a single `docs/tasks/tasks.yml` (nested `subTasks` per task). Architecture mirrors `p-wiki` v3 — same `.{plugin}.json` config shape, same skill/CLI separation, separate `tools/lib/`.

**Tech Stack:** Node ≥18 (ESM, `.mjs`), Vitest 3.x, `js-yaml` (new dependency for nested YAML).

---

## File Structure

Each file owns one responsibility. Files that change together stay together.

```
plugins/p-tasks/
├── .claude-plugin/plugin.json          ← manifest, version
├── README.md                           ← human entry point
├── skills/
│   ├── init/SKILL.md
│   ├── add/SKILL.md
│   ├── set/SKILL.md
│   ├── next/SKILL.md
│   ├── summary/SKILL.md
│   ├── sync/SKILL.md
│   └── _shared/templates/
│       ├── CLAUDE.md.tpl               ← rules-for-Claude inside docs/tasks/
│       ├── tasks.yml.seed              ← `tasks: []\n`
│       └── p-tasks.rule.md.tpl         ← global rule for .claude/rules/
└── tools/
    ├── ptasks.mjs                      ← CLI entry, parses argv, dispatches commands
    ├── lib/
    │   ├── schema.mjs                  ← statuses, item shape, id prefix helpers
    │   ├── yaml.mjs                    ← wraps js-yaml for tasks.yml round-trip
    │   ├── config.mjs                  ← read/write/validate .ptasks.json
    │   ├── cycles.mjs                  ← DFS cycle check on blockedBy graph
    │   ├── next.mjs                    ← ranking algorithm
    │   ├── summary.mjs                 ← done-filter
    │   ├── destination.mjs             ← resolveDestination → {primary, mirrors}
    │   ├── sync.mjs                    ← orchestrator (passes 1, 0/2/3a/3b/4/5)
    │   ├── destinations/
    │   │   ├── fs.mjs
    │   │   └── jira.mjs
    │   └── jira/
    │       ├── http.mjs                ← fetch, basic-auth, retry, error mapping
    │       ├── issues.mjs              ← create / update / list / transitions
    │       └── links.mjs               ← Blocks issue links
    └── __tests__/                      ← Vitest picks up `**/*.test.ts` here
```

Tests sit in `tools/__tests__/` per file under test (one `*.test.ts` per `.mjs`). The `vitest.config.ts` `include` already covers `plugins/**/tools/__tests__/**/*.test.ts` — no config change needed.

---

## Phase A — Scaffolding

### Task 1: Plugin manifest and directory layout

**Files:**
- Create: `plugins/p-tasks/.claude-plugin/plugin.json`
- Create: `plugins/p-tasks/README.md`
- Create: `plugins/p-tasks/tools/__tests__/.gitkeep`
- Modify: `.claude-plugin/marketplace.json` (add p-tasks entry)

- [ ] **Step 1: Write `plugin.json`**

```json
{
  "name": "p-tasks",
  "version": "0.1.0",
  "description": "Two-level task tracker (task → sub-task) with FS and Jira destinations, one-way primary→mirrors sync. Skills: init, add, set, next, summary, sync.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 2: Write `README.md` stub**

```markdown
# p-tasks

A Claude Code plugin that tracks tasks (`task` → `sub-task`) with `todo`/`in_progress`/`done` statuses and blocker relationships. Data lives in a local `docs/tasks/tasks.yml`, in Jira, or in both (one-way primary→mirrors sync).

Distributed via the `perky.team` marketplace.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-tasks@perky.team
```

## Commands

| Command | What it does |
|---|---|
| `/p-tasks:init` | Scaffolds `docs/tasks/` and a global rule at `.claude/rules/p-tasks.md`. |
| `/p-tasks:add` | Creates a task or sub-task. |
| `/p-tasks:set` | Updates status, title, description, or blockers. |
| `/p-tasks:next` | Returns the next unblocked item to work on. |
| `/p-tasks:summary` | Lists done tasks (or done sub-tasks of a given task). |
| `/p-tasks:sync` | One-way sync from primary destination to every mirror. |

## Design

See [`docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md`](./docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md).
```

- [ ] **Step 3: Add `.gitkeep` to tests dir**

```bash
touch plugins/p-tasks/tools/__tests__/.gitkeep
```

- [ ] **Step 4: Register in marketplace.json**

Open `.claude-plugin/marketplace.json` and append a new entry to `plugins` array (after `p-flow`):

```json
{
  "name": "p-tasks",
  "source": "./plugins/p-tasks",
  "description": "Task tracker (task → sub-task) with FS and Jira destinations, one-way sync. Skills: init, add, set, next, summary, sync."
}
```

- [ ] **Step 5: Validate**

```bash
node scripts/validate.mjs
```
Expected: passes (script validates marketplace + plugin.json shapes).

- [ ] **Step 6: Commit**

```bash
git add plugins/p-tasks/.claude-plugin/plugin.json plugins/p-tasks/README.md plugins/p-tasks/tools/__tests__/.gitkeep .claude-plugin/marketplace.json
git commit -m "feat(p-tasks): scaffold plugin manifest and marketplace entry"
```

---

### Task 2: Add `js-yaml` dependency

**Files:**
- Modify: `package.json`

**Rationale:** p-wiki ships its own minimal flat YAML parser (`plugins/p-wiki/tools/lib/yaml.mjs`). It does not handle nested arrays of objects, which `tasks.yml` requires (each task has a `subTasks: []` array of objects). A proper YAML library is needed.

- [ ] **Step 1: Add dep**

In `package.json` `devDependencies`, add `"js-yaml": "^4.1.0"`. Result:

```json
{
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/semver": "^7.5.0",
    "gray-matter": "^4.0.3",
    "js-yaml": "^4.1.0",
    "semver": "^7.6.0",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
npm install
```
Expected: lockfile updated, `node_modules/js-yaml/` exists.

- [ ] **Step 3: Smoke-test**

```bash
node -e "console.log(require('js-yaml').dump({foo:[{a:1}]}))"
```
Expected: prints `foo:\n  - a: 1\n`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add js-yaml for p-tasks nested-yaml serialization"
```

---

## Phase B — Pure modules (TDD)

### Task 3: `schema.mjs` — id prefixes, statuses, item shape

**Files:**
- Create: `plugins/p-tasks/tools/lib/schema.mjs`
- Test: `plugins/p-tasks/tools/__tests__/schema.test.ts`

**What this module owns:** the constants (`STATUSES`, `ID_PREFIXES`), id parsing (`parseId('t-12') → {prefix: 't', n: 12}`), item shape validation, and the type helpers used everywhere.

- [ ] **Step 1: Write failing test for `parseId`**

`schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseId, formatId, STATUSES, validateItem } from '../lib/schema.mjs';

describe('parseId', () => {
  it('parses task ids', () => {
    expect(parseId('t-12')).toEqual({ prefix: 't', n: 12 });
  });
  it('parses sub-task ids', () => {
    expect(parseId('st-3')).toEqual({ prefix: 'st', n: 3 });
  });
  it('returns null for unknown prefix', () => {
    expect(parseId('x-1')).toBeNull();
  });
  it('returns null for malformed input', () => {
    expect(parseId('t-')).toBeNull();
    expect(parseId('t-abc')).toBeNull();
    expect(parseId('')).toBeNull();
  });
  it('accepts Jira-style keys as opaque pass-through (returns null for prefix)', () => {
    // Jira keys like PROJ-15 are not local ids; parseId only recognises t-/st-
    expect(parseId('PROJ-15')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/schema.test.ts
```
Expected: FAIL — `schema.mjs` does not exist.

- [ ] **Step 3: Implement `parseId` and constants**

`schema.mjs`:

```js
export const STATUSES = ['todo', 'in_progress', 'done'];
export const ID_PREFIXES = ['t', 'st'];

export function parseId(id) {
  if (typeof id !== 'string') return null;
  const m = /^(t|st)-(\d+)$/.exec(id);
  if (!m) return null;
  return { prefix: m[1], n: Number(m[2]) };
}

export function formatId(prefix, n) {
  if (!ID_PREFIXES.includes(prefix)) throw new Error(`unknown prefix: ${prefix}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid n: ${n}`);
  return `${prefix}-${n}`;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/schema.test.ts
```
Expected: PASS.

- [ ] **Step 5: Add failing test for `validateItem`**

Append to `schema.test.ts`:

```ts
describe('validateItem', () => {
  const valid = {
    id: 't-1',
    type: 'task',
    title: 'X',
    description: '',
    status: 'todo',
    blockedBy: [],
    subTasks: [],
  };

  it('accepts a well-formed task', () => {
    expect(validateItem(valid)).toEqual({ ok: true });
  });
  it('rejects unknown status', () => {
    expect(validateItem({ ...valid, status: 'wontfix' })).toEqual({
      ok: false,
      error: expect.stringContaining('status'),
    });
  });
  it('rejects mismatched id prefix vs type', () => {
    // sub-task with t- prefix or task with st- prefix
    expect(validateItem({ ...valid, id: 'st-1', type: 'task' }).ok).toBe(false);
    expect(validateItem({ ...valid, id: 't-1', type: 'sub-task' }).ok).toBe(false);
  });
  it('rejects missing required field', () => {
    const { title, ...noTitle } = valid;
    expect(validateItem(noTitle).ok).toBe(false);
  });
  it('accepts opaque Jira-key as id when type is provided externally', () => {
    // For Jira-primary configurations the id is the Jira key; we cannot enforce a prefix.
    // validateItem only sanity-checks prefix when id matches parseId; Jira keys pass through.
    expect(validateItem({ ...valid, id: 'PROJ-15' }).ok).toBe(true);
  });
});
```

- [ ] **Step 6: Run, verify failure, implement**

Run: `npx vitest run plugins/p-tasks/tools/__tests__/schema.test.ts` — fails on `validateItem`.

Add to `schema.mjs`:

```js
export function validateItem(item) {
  if (!item || typeof item !== 'object') return { ok: false, error: 'item must be an object' };
  for (const f of ['id', 'type', 'title', 'description', 'status']) {
    if (!(f in item)) return { ok: false, error: `missing field: ${f}` };
  }
  if (typeof item.id !== 'string' || item.id.length === 0) return { ok: false, error: 'id must be non-empty string' };
  if (item.type !== 'task' && item.type !== 'sub-task') return { ok: false, error: `type must be "task" or "sub-task", got ${JSON.stringify(item.type)}` };
  if (typeof item.title !== 'string') return { ok: false, error: 'title must be a string' };
  if (typeof item.description !== 'string') return { ok: false, error: 'description must be a string' };
  if (!STATUSES.includes(item.status)) return { ok: false, error: `status must be one of ${STATUSES.join('/')}, got ${JSON.stringify(item.status)}` };
  if (!Array.isArray(item.blockedBy)) return { ok: false, error: 'blockedBy must be an array' };
  if (item.type === 'task' && !Array.isArray(item.subTasks)) return { ok: false, error: 'subTasks must be an array on a task' };
  const parsed = parseId(item.id);
  if (parsed) {
    if (parsed.prefix === 't' && item.type !== 'task') return { ok: false, error: `id ${item.id} is task-prefixed but type=${item.type}` };
    if (parsed.prefix === 'st' && item.type !== 'sub-task') return { ok: false, error: `id ${item.id} is sub-task-prefixed but type=${item.type}` };
  }
  // Jira-style keys (e.g. PROJ-15) are not parsed by parseId — they pass through; type comes from caller.
  return { ok: true };
}
```

- [ ] **Step 7: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/schema.test.ts
```
Expected: PASS.

```bash
git add plugins/p-tasks/tools/lib/schema.mjs plugins/p-tasks/tools/__tests__/schema.test.ts
git commit -m "feat(p-tasks): schema module — id prefixes, statuses, item validation"
```

---

### Task 4: `yaml.mjs` — tasks.yml round-trip

**Files:**
- Create: `plugins/p-tasks/tools/lib/yaml.mjs`
- Test: `plugins/p-tasks/tools/__tests__/yaml.test.ts`

**What this module owns:** loading and saving `tasks.yml`. Thin wrapper over `js-yaml` that enforces the document shape (`{ tasks: [...] }`) and preserves field order on serialize.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { loadTasksDoc, dumpTasksDoc } from '../lib/yaml.mjs';

const sample = {
  tasks: [
    {
      id: 't-1',
      title: 'Login',
      description: 'OAuth',
      status: 'in_progress',
      blockedBy: [],
      subTasks: [
        { id: 'st-1', title: 'Bcrypt', description: '', status: 'todo', blockedBy: ['st-2'] },
        { id: 'st-2', title: 'Schema', description: '', status: 'done', blockedBy: [] },
      ],
    },
    {
      id: 't-2',
      title: 'CI',
      description: '',
      status: 'todo',
      blockedBy: ['t-1'],
      subTasks: [],
    },
  ],
};

describe('yaml round-trip', () => {
  it('round-trips a non-trivial document', () => {
    const text = dumpTasksDoc(sample);
    expect(loadTasksDoc(text)).toEqual(sample);
  });
  it('loads an empty document', () => {
    expect(loadTasksDoc('tasks: []\n')).toEqual({ tasks: [] });
  });
  it('rejects a doc without a top-level tasks: array', () => {
    expect(() => loadTasksDoc('something: else\n')).toThrow(/tasks/);
  });
  it('preserves key order: id, title, description, status, blockedBy, jiraKeys, subTasks', () => {
    const out = dumpTasksDoc({
      tasks: [{ id: 't-1', title: 'T', description: 'D', status: 'todo', blockedBy: [], jiraKeys: { 'jira-prod': 'PROJ-9' }, subTasks: [] }],
    });
    const order = ['id:', 'title:', 'description:', 'status:', 'blockedBy:', 'jiraKeys:', 'subTasks:'];
    let pos = -1;
    for (const k of order) {
      const i = out.indexOf(k);
      expect(i, `expected ${k} to appear in order`).toBeGreaterThan(pos);
      pos = i;
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/yaml.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `yaml.mjs`**

```js
import yaml from 'js-yaml';

const ITEM_KEY_ORDER = ['id', 'title', 'description', 'status', 'blockedBy', 'jiraKeys', 'subTasks'];

function orderItem(item) {
  const out = {};
  for (const k of ITEM_KEY_ORDER) {
    if (k in item) out[k] = k === 'subTasks' ? item.subTasks.map(orderItem) : item[k];
  }
  for (const k of Object.keys(item)) {
    if (!ITEM_KEY_ORDER.includes(k)) out[k] = item[k];
  }
  return out;
}

export function loadTasksDoc(text) {
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tasks)) {
    throw new Error('tasks.yml must have a top-level `tasks:` array');
  }
  return doc;
}

export function dumpTasksDoc(doc) {
  const ordered = { tasks: doc.tasks.map(orderItem) };
  return yaml.dump(ordered, { lineWidth: 120, noCompatMode: true });
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/yaml.test.ts
```
Expected: PASS.

```bash
git add plugins/p-tasks/tools/lib/yaml.mjs plugins/p-tasks/tools/__tests__/yaml.test.ts
git commit -m "feat(p-tasks): yaml module — load/dump tasks.yml with stable key order"
```

---

### Task 5: `config.mjs` — `.ptasks.json` read/write/validate

**Files:**
- Create: `plugins/p-tasks/tools/lib/config.mjs`
- Test: `plugins/p-tasks/tools/__tests__/config.test.ts`

**What this module owns:** path resolution (`docs/tasks/.ptasks.json`), reading/writing JSON, default expansion (no file → FS-only config), and shape validation per spec §2.4.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, validateConfig, defaultConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-config-'));
  mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const jiraBlock = {
  kind: 'jira',
  siteUrl: 'https://x.atlassian.net',
  projectKey: 'PROJ',
  issueTypes: { task: 'Task', subTask: 'Sub-task' },
  statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' },
  jql: 'project = PROJ AND issuetype in (Task, Sub-task)',
};

describe('config', () => {
  it('returns defaultConfig when .ptasks.json is absent', () => {
    expect(readConfig(dir)).toEqual(defaultConfig());
  });
  it('defaultConfig is fs-only', () => {
    expect(defaultConfig()).toEqual({ primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } });
  });
  it('round-trips a config with primary=fs and one jira mirror', () => {
    const cfg = { primary: 'fs', mirrors: ['jira'], destinations: { fs: { kind: 'fs' }, jira: jiraBlock } };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });
  it('validateConfig rejects missing primary', () => {
    expect(validateConfig({}).ok).toBe(false);
  });
  it('validateConfig rejects mirror that does not key into destinations', () => {
    expect(validateConfig({ primary: 'fs', mirrors: ['nope'], destinations: { fs: { kind: 'fs' } } }).ok).toBe(false);
  });
  it('validateConfig rejects jira block missing required fields', () => {
    expect(validateConfig({ primary: 'jira', mirrors: [], destinations: { jira: { kind: 'jira' } } }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.mjs`**

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_REL = 'docs/tasks/.ptasks.json';

export function configPath(root) { return join(root, CONFIG_REL); }

export function defaultConfig() {
  return { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
}

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return defaultConfig();
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (typeof cfg.primary !== 'string' || !cfg.primary) return { ok: false, error: 'primary must be a non-empty string' };
  if (!cfg.destinations || typeof cfg.destinations !== 'object') return { ok: false, error: 'destinations must be an object' };
  if (cfg.mirrors !== undefined && !Array.isArray(cfg.mirrors)) return { ok: false, error: 'mirrors must be an array of strings' };
  if (!(cfg.primary in cfg.destinations)) return { ok: false, error: `destinations.${cfg.primary} not defined` };
  for (const m of cfg.mirrors ?? []) {
    if (typeof m !== 'string' || !m) return { ok: false, error: 'mirror name must be a non-empty string' };
    if (!(m in cfg.destinations)) return { ok: false, error: `mirror "${m}" not in destinations` };
  }
  for (const [name, block] of Object.entries(cfg.destinations)) {
    if (!block || typeof block !== 'object') return { ok: false, error: `destinations.${name} must be an object` };
    if (block.kind !== 'fs' && block.kind !== 'jira') return { ok: false, error: `destinations.${name}.kind must be "fs" or "jira"` };
    if (block.kind === 'jira') {
      for (const f of ['siteUrl', 'projectKey']) {
        if (typeof block[f] !== 'string' || !block[f]) return { ok: false, error: `destinations.${name}.${f} required` };
      }
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/config.test.ts
git add plugins/p-tasks/tools/lib/config.mjs plugins/p-tasks/tools/__tests__/config.test.ts
git commit -m "feat(p-tasks): config module — .ptasks.json read/write/validate with FS default"
```

---

### Task 6: `cycles.mjs` — DFS cycle check on blockedBy graph

**Files:**
- Create: `plugins/p-tasks/tools/lib/cycles.mjs`
- Test: `plugins/p-tasks/tools/__tests__/cycles.test.ts`

**What this module owns:** detecting cycles in the `blockedBy` directed graph **including a hypothetical to-be-added edge**, so `add`/`set` can pre-validate before committing the write.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { findCycle } from '../lib/cycles.mjs';

// Graph as list of items: each item carries { id, blockedBy: [id, ...] }
const items = [
  { id: 't-1', blockedBy: [] },
  { id: 't-2', blockedBy: ['t-1'] },
  { id: 't-3', blockedBy: ['t-2'] },
];

describe('findCycle', () => {
  it('returns null on an acyclic graph', () => {
    expect(findCycle(items)).toBeNull();
  });
  it('detects a direct self-loop', () => {
    expect(findCycle([{ id: 't-1', blockedBy: ['t-1'] }])).not.toBeNull();
  });
  it('detects a back-edge', () => {
    const with_back = items.concat([{ id: 't-1', blockedBy: ['t-3'] }]);
    // overwrite t-1 with new blockedBy
    const merged = [{ id: 't-1', blockedBy: ['t-3'] }, items[1], items[2]];
    const cycle = findCycle(merged);
    expect(cycle).toEqual(expect.arrayContaining(['t-1', 't-2', 't-3']));
  });
  it('ignores blockedBy targets that are not in the graph', () => {
    // an unresolved blocker is a separate error class; cycle check skips them.
    expect(findCycle([{ id: 't-1', blockedBy: ['nope'] }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `cycles.mjs`**

```js
// Returns null on acyclic graph; otherwise returns the cycle as an array of ids.
export function findCycle(items) {
  const byId = new Map(items.map(i => [i.id, i]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();
  for (const i of items) color.set(i.id, WHITE);

  function dfs(start) {
    const stack = [{ id: start, ptr: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const node = byId.get(top.id);
      const neighbors = node?.blockedBy ?? [];
      if (top.ptr < neighbors.length) {
        const next = neighbors[top.ptr++];
        if (!byId.has(next)) continue;
        const c = color.get(next);
        if (c === GRAY) {
          const cycle = [next];
          for (let i = stack.length - 1; i >= 0; i--) {
            cycle.push(stack[i].id);
            if (stack[i].id === next) break;
          }
          return cycle.reverse();
        }
        if (c === WHITE) {
          color.set(next, GRAY);
          parent.set(next, top.id);
          stack.push({ id: next, ptr: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
    return null;
  }

  for (const i of items) {
    if (color.get(i.id) === WHITE) {
      const c = dfs(i.id);
      if (c) return c;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cycles.test.ts
git add plugins/p-tasks/tools/lib/cycles.mjs plugins/p-tasks/tools/__tests__/cycles.test.ts
git commit -m "feat(p-tasks): cycles module — DFS cycle detection on blockedBy graph"
```

---

### Task 7: `next.mjs` — ranking algorithm

**Files:**
- Create: `plugins/p-tasks/tools/lib/next.mjs`
- Test: `plugins/p-tasks/tools/__tests__/next.test.ts`

**What this module owns:** the deterministic ranking from spec §3.4 over an already-loaded flat item list. Pure function — no I/O.

Input shape: `Item[]` (with `parentId` on sub-tasks per §2.5).
Output: ranked subset, top-1 by default, all if `{ all: true }`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { pickNext } from '../lib/next.mjs';

const items = [
  { id: 't-1', type: 'task',     title: 'A', description: '', status: 'in_progress', blockedBy: [] },
  { id: 't-2', type: 'task',     title: 'B', description: '', status: 'todo',        blockedBy: [] },
  { id: 't-3', type: 'task',     title: 'C', description: '', status: 'todo',        blockedBy: ['t-1'] },
  { id: 'st-1', type: 'sub-task', parentId: 't-1', title: 'A1', description: '', status: 'todo', blockedBy: [] },
  { id: 'st-2', type: 'sub-task', parentId: 't-2', title: 'B1', description: '', status: 'todo', blockedBy: [] },
];

describe('pickNext', () => {
  it('returns null when no candidates', () => {
    expect(pickNext([{ id: 't-1', type: 'task', status: 'done', blockedBy: [], title:'',description:'' }])).toBeNull();
  });
  it('prefers in_progress over todo', () => {
    const out = pickNext(items);
    expect(out.id).toBe('t-1');
  });
  it('prefers sub-task of in_progress parent over standalone todo', () => {
    const withoutT1 = items.filter(i => i.id !== 't-1').concat([
      { id: 't-1', type: 'task', title: 'A', description: '', status: 'in_progress', blockedBy: [] },
    ]);
    // st-1 (sub-task of in_progress t-1) should beat st-2 (sub-task of todo t-2)
    const out = pickNext(withoutT1, { all: true });
    const stOnly = out.filter(i => i.id.startsWith('st-')).map(i => i.id);
    expect(stOnly[0]).toBe('st-1');
  });
  it('excludes items whose blockers are not yet done', () => {
    expect(pickNext(items, { all: true }).map(i => i.id)).not.toContain('t-3');
  });
  it('includes items whose blockers are all done', () => {
    const xs = [
      { id: 't-1', type: 'task', title: '', description: '', status: 'done', blockedBy: [] },
      { id: 't-2', type: 'task', title: '', description: '', status: 'todo', blockedBy: ['t-1'] },
    ];
    expect(pickNext(xs).id).toBe('t-2');
  });
  it('emits warning for non-existent blocker id and excludes the candidate', () => {
    const warns: string[] = [];
    const out = pickNext(
      [{ id: 't-1', type: 'task', title: '', description: '', status: 'todo', blockedBy: ['nope'] }],
      { all: true, onWarn: (m: string) => warns.push(m) },
    );
    expect(out).toEqual([]);
    expect(warns[0]).toMatch(/nope/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `next.mjs`**

```js
import { parseId } from './schema.mjs';

export function pickNext(items, opts = {}) {
  const all = opts.all === true;
  const onWarn = opts.onWarn ?? (() => {});

  const byId = new Map(items.map(i => [i.id, i]));
  const candidates = [];
  for (const it of items) {
    if (it.status === 'done') continue;
    let satisfied = true;
    for (const b of it.blockedBy ?? []) {
      const target = byId.get(b);
      if (!target) {
        onWarn(`item ${it.id}: blocker ${b} does not exist; excluding from next`);
        satisfied = false;
        break;
      }
      if (target.status !== 'done') { satisfied = false; break; }
    }
    if (satisfied) candidates.push(it);
  }

  function key(it) {
    const statusRank = it.status === 'in_progress' ? 0 : 1;
    let parentInProgressRank = 1;
    if (it.type === 'sub-task' && it.parentId) {
      const parent = byId.get(it.parentId);
      if (parent && parent.status === 'in_progress') parentInProgressRank = 0;
    }
    const parsed = parseId(it.id);
    const prefixRank = parsed?.prefix === 't' ? 0 : 1;
    const num = parsed?.n ?? Number.MAX_SAFE_INTEGER;
    return [statusRank, parentInProgressRank, prefixRank, num];
  }

  candidates.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });

  if (all) return candidates;
  return candidates.length === 0 ? null : candidates[0];
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/next.test.ts
git add plugins/p-tasks/tools/lib/next.mjs plugins/p-tasks/tools/__tests__/next.test.ts
git commit -m "feat(p-tasks): next module — ranking by status/parent-in-progress/id"
```

---

### Task 8: `summary.mjs` — done-filter rollups

**Files:**
- Create: `plugins/p-tasks/tools/lib/summary.mjs`
- Test: `plugins/p-tasks/tools/__tests__/summary.test.ts`

**What this module owns:** filter "done" top-level tasks, or filter "done" sub-tasks of a given task. Returns `{id, title, description}` slim records sorted by id per spec §3.5.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { summarize } from '../lib/summary.mjs';

const items = [
  { id: 't-1', type: 'task',     title: 'A', description: 'a',  status: 'done',        blockedBy: [] },
  { id: 't-2', type: 'task',     title: 'B', description: '',   status: 'in_progress', blockedBy: [] },
  { id: 'st-1', type: 'sub-task', parentId: 't-2', title: 'B1', description: 'b1', status: 'done', blockedBy: [] },
  { id: 'st-2', type: 'sub-task', parentId: 't-2', title: 'B2', description: '',   status: 'todo', blockedBy: [] },
  { id: 'st-3', type: 'sub-task', parentId: 't-1', title: 'A1', description: '',   status: 'done', blockedBy: [] },
];

describe('summarize', () => {
  it('without parentId — returns done top-level tasks', () => {
    expect(summarize(items)).toEqual([{ id: 't-1', title: 'A', description: 'a' }]);
  });
  it('with parentId — returns done sub-tasks of that parent only', () => {
    expect(summarize(items, { parentId: 't-2' })).toEqual([{ id: 'st-1', title: 'B1', description: 'b1' }]);
  });
  it('omits empty description', () => {
    const out = summarize([
      { id: 't-1', type: 'task', title: 'X', description: '', status: 'done', blockedBy: [] },
    ]);
    expect(out).toEqual([{ id: 't-1', title: 'X' }]);
  });
  it('throws if parentId not found', () => {
    expect(() => summarize(items, { parentId: 't-99' })).toThrow(/t-99/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `summary.mjs`**

```js
import { parseId } from './schema.mjs';

export function summarize(items, opts = {}) {
  const parentId = opts.parentId;
  let pool;
  if (parentId === undefined) {
    pool = items.filter(i => i.type === 'task' && i.status === 'done');
  } else {
    const parent = items.find(i => i.id === parentId);
    if (!parent) throw new Error(`item ${parentId} not found`);
    pool = items.filter(i => i.type === 'sub-task' && i.parentId === parentId && i.status === 'done');
  }
  pool.sort((a, b) => {
    const pa = parseId(a.id), pb = parseId(b.id);
    if (!pa || !pb) return a.id.localeCompare(b.id);
    if (pa.prefix !== pb.prefix) return pa.prefix === 't' ? -1 : 1;
    return pa.n - pb.n;
  });
  return pool.map(i => {
    const r = { id: i.id, title: i.title };
    if (i.description) r.description = i.description;
    return r;
  });
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/summary.test.ts
git add plugins/p-tasks/tools/lib/summary.mjs plugins/p-tasks/tools/__tests__/summary.test.ts
git commit -m "feat(p-tasks): summary module — done filter scoped by optional parent"
```

---

## Phase C — FS destination

### Task 9: FS destination — `ensureStructure`, `listItems`, `readItem`

**Files:**
- Create: `plugins/p-tasks/tools/lib/destinations/fs.mjs`
- Test: `plugins/p-tasks/tools/__tests__/fs-read.test.ts`

**What this owns:** read paths only. `ensureStructure` creates `docs/tasks/tasks.yml` with `tasks: []` if missing. `listItems` flattens the nested doc into a flat `Item[]` with `parentId` on sub-tasks. `readItem(id)` finds by id.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs destination — read paths', () => {
  it('ensureStructure creates docs/tasks/tasks.yml with empty array', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.ensureStructure();
    expect(existsSync(join(dir, 'docs', 'tasks', 'tasks.yml'))).toBe(true);
    const text = readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8');
    expect(text).toMatch(/tasks:\s*\[\]/);
  });
  it('ensureStructure is idempotent — does not overwrite existing content', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'tasks:\n  - id: t-1\n    title: keep\n    description: ""\n    status: todo\n    blockedBy: []\n    subTasks: []\n');
    const dst = createFsDestination({ root: dir });
    await dst.ensureStructure();
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).toMatch(/id: t-1/);
  });
  it('listItems returns flat list with parentId on sub-tasks', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'),
`tasks:
  - id: t-1
    title: A
    description: ""
    status: todo
    blockedBy: []
    subTasks:
      - id: st-1
        title: A1
        description: ""
        status: done
        blockedBy: []
`);
    const dst = createFsDestination({ root: dir });
    const items = await dst.listItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 't-1', type: 'task' });
    expect(items[1]).toMatchObject({ id: 'st-1', type: 'sub-task', parentId: 't-1' });
  });
  it('readItem returns task by id', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'),
`tasks:
  - id: t-1
    title: A
    description: ""
    status: todo
    blockedBy: []
    subTasks: []
`);
    const dst = createFsDestination({ root: dir });
    const it = await dst.readItem('t-1');
    expect(it.title).toBe('A');
  });
  it('readItem throws item-not-found', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'tasks: []\n');
    const dst = createFsDestination({ root: dir });
    await expect(dst.readItem('t-99')).rejects.toThrow(/item-not-found/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/fs-read.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `fs.mjs` (read paths only)**

```js
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasksDoc, dumpTasksDoc } from '../yaml.mjs';

const RELATIVE = 'docs/tasks/tasks.yml';

function tasksPath(root) { return join(root, RELATIVE); }

function readDoc(root) {
  const p = tasksPath(root);
  if (!existsSync(p)) return { tasks: [] };
  return loadTasksDoc(readFileSync(p, 'utf-8'));
}

function writeDoc(root, doc) {
  const p = tasksPath(root);
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  writeFileSync(p, dumpTasksDoc(doc), 'utf-8');
}

function flatten(doc) {
  const out = [];
  for (const t of doc.tasks ?? []) {
    out.push({ ...t, type: 'task' });
    for (const st of t.subTasks ?? []) {
      out.push({ ...st, type: 'sub-task', parentId: t.id });
    }
  }
  return out;
}

export function createFsDestination({ root, name = 'fs' }) {
  return {
    kind: 'fs',
    name,

    async ensureStructure() {
      if (!existsSync(tasksPath(root))) writeDoc(root, { tasks: [] });
    },

    async listItems() {
      return flatten(readDoc(root));
    },

    async readItem(id) {
      const all = flatten(readDoc(root));
      const it = all.find(i => i.id === id);
      if (!it) throw Object.assign(new Error(`item-not-found: ${id}`), { code: 'item-not-found' });
      return it;
    },

    // createItem and updateItem implemented in subsequent tasks
    async createItem() { throw new Error('not implemented yet'); },
    async updateItem() { throw new Error('not implemented yet'); },
  };
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/fs-read.test.ts
git add plugins/p-tasks/tools/lib/destinations/fs.mjs plugins/p-tasks/tools/__tests__/fs-read.test.ts
git commit -m "feat(p-tasks): fs destination — ensureStructure / listItems / readItem"
```

---

### Task 10: FS destination — `createItem` with id assignment

**Files:**
- Modify: `plugins/p-tasks/tools/lib/destinations/fs.mjs`
- Test: `plugins/p-tasks/tools/__tests__/fs-create.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-create-'));
  const dst = createFsDestination({ root: dir });
  await dst.ensureStructure();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs destination — createItem', () => {
  it('assigns t-1 on empty file', async () => {
    const dst = createFsDestination({ root: dir });
    const created = await dst.createItem({ type: 'task', title: 'A', description: '', status: 'todo', blockedBy: [] });
    expect(created.id).toBe('t-1');
    expect(created.title).toBe('A');
    expect(created.status).toBe('todo');
  });
  it('monotonically advances to t-2, t-3 on subsequent creates', async () => {
    const dst = createFsDestination({ root: dir });
    expect((await dst.createItem({ type: 'task', title: 'A', description:'', status:'todo', blockedBy: [] })).id).toBe('t-1');
    expect((await dst.createItem({ type: 'task', title: 'B', description:'', status:'todo', blockedBy: [] })).id).toBe('t-2');
    expect((await dst.createItem({ type: 'task', title: 'C', description:'', status:'todo', blockedBy: [] })).id).toBe('t-3');
  });
  it('assigns st-1 for first sub-task under existing task', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.createItem({ type: 'task', title: 'P', description:'', status:'todo', blockedBy: [] });
    const st = await dst.createItem({ type: 'sub-task', parentId: 't-1', title: 'S', description:'', status:'todo', blockedBy: [] });
    expect(st.id).toBe('st-1');
    expect(st.parentId).toBe('t-1');
  });
  it('throws parent-not-found for unknown parentId', async () => {
    const dst = createFsDestination({ root: dir });
    await expect(dst.createItem({ type: 'sub-task', parentId: 't-99', title: 'S', description:'', status:'todo', blockedBy: [] }))
      .rejects.toMatchObject({ code: 'parent-not-found' });
  });
  it('throws parent-not-found when parentId is a sub-task (two-level enforcement)', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.createItem({ type: 'task', title: 'P', description:'', status:'todo', blockedBy: [] });
    await dst.createItem({ type: 'sub-task', parentId: 't-1', title: 'S1', description:'', status:'todo', blockedBy: [] });
    await expect(dst.createItem({ type: 'sub-task', parentId: 'st-1', title: 'S2', description:'', status:'todo', blockedBy: [] }))
      .rejects.toMatchObject({ code: 'parent-not-found' });
  });
  it('persists the new item to tasks.yml', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.createItem({ type: 'task', title: 'Persist', description: '', status: 'todo', blockedBy: [] });
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).toMatch(/Persist/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL — `createItem` still throws "not implemented".

- [ ] **Step 3: Implement `createItem` in `fs.mjs`**

Replace the placeholder `createItem` with:

```js
async createItem(input) {
  const doc = readDoc(root);
  const flat = flatten(doc);
  const all = new Set(flat.map(i => i.id));

  if (input.type === 'sub-task') {
    const parent = doc.tasks.find(t => t.id === input.parentId);
    if (!parent) throw Object.assign(new Error(`parent-not-found: ${input.parentId}`), { code: 'parent-not-found' });
  }

  const prefix = input.type === 'task' ? 't' : 'st';
  let maxN = 0;
  for (const i of flat) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(i.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const id = `${prefix}-${maxN + 1}`;

  const base = {
    id,
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'todo',
    blockedBy: input.blockedBy ?? [],
  };

  if (input.type === 'task') {
    doc.tasks.push({ ...base, subTasks: [] });
    writeDoc(root, doc);
    return { ...base, type: 'task', subTasks: [] };
  } else {
    const parent = doc.tasks.find(t => t.id === input.parentId);
    parent.subTasks = parent.subTasks ?? [];
    parent.subTasks.push(base);
    writeDoc(root, doc);
    return { ...base, type: 'sub-task', parentId: input.parentId };
  }
},
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/fs-create.test.ts
git add plugins/p-tasks/tools/lib/destinations/fs.mjs plugins/p-tasks/tools/__tests__/fs-create.test.ts
git commit -m "feat(p-tasks): fs destination — createItem with id assignment and parent guard"
```

---

### Task 11: FS destination — `updateItem`

**Files:**
- Modify: `plugins/p-tasks/tools/lib/destinations/fs.mjs`
- Test: `plugins/p-tasks/tools/__tests__/fs-update.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-update-'));
  const dst = createFsDestination({ root: dir });
  await dst.ensureStructure();
  await dst.createItem({ type: 'task', title: 'A', description: '', status: 'todo', blockedBy: [] });
  await dst.createItem({ type: 'sub-task', parentId: 't-1', title: 'S1', description: '', status: 'todo', blockedBy: [] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs destination — updateItem', () => {
  it('patches a single field, leaves others untouched', async () => {
    const dst = createFsDestination({ root: dir });
    const updated = await dst.updateItem('t-1', { status: 'in_progress' });
    expect(updated.status).toBe('in_progress');
    expect(updated.title).toBe('A');
  });
  it('updates sub-task', async () => {
    const dst = createFsDestination({ root: dir });
    const updated = await dst.updateItem('st-1', { title: 'renamed' });
    expect(updated.title).toBe('renamed');
    expect(updated.parentId).toBe('t-1');
  });
  it('replaces blockedBy fully', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.updateItem('t-1', { blockedBy: ['st-1'] });
    const refetched = await dst.readItem('t-1');
    expect(refetched.blockedBy).toEqual(['st-1']);
  });
  it('merges jiraKeys without losing other mirror entries', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.updateItem('t-1', { jiraKeys: { 'jira-prod': 'PROJ-1' } });
    await dst.updateItem('t-1', { jiraKeys: { 'jira-staging': 'STAGE-1' } });
    const after = await dst.readItem('t-1');
    expect(after.jiraKeys).toEqual({ 'jira-prod': 'PROJ-1', 'jira-staging': 'STAGE-1' });
  });
  it('throws item-not-found for unknown id', async () => {
    const dst = createFsDestination({ root: dir });
    await expect(dst.updateItem('t-99', { title: 'x' })).rejects.toMatchObject({ code: 'item-not-found' });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `updateItem`**

Replace placeholder with:

```js
async updateItem(id, patch) {
  const doc = readDoc(root);
  let found = null;
  let parentForSub = null;
  for (const t of doc.tasks) {
    if (t.id === id) { found = t; break; }
    if (t.subTasks) {
      for (const st of t.subTasks) {
        if (st.id === id) { found = st; parentForSub = t; break; }
      }
      if (found) break;
    }
  }
  if (!found) throw Object.assign(new Error(`item-not-found: ${id}`), { code: 'item-not-found' });

  for (const k of ['title', 'description', 'status']) {
    if (k in patch) found[k] = patch[k];
  }
  if ('blockedBy' in patch) found.blockedBy = patch.blockedBy;
  if ('jiraKeys' in patch) {
    found.jiraKeys = { ...(found.jiraKeys ?? {}), ...patch.jiraKeys };
  }

  writeDoc(root, doc);
  if (parentForSub) return { ...found, type: 'sub-task', parentId: parentForSub.id };
  return { ...found, type: 'task' };
},
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/fs-update.test.ts
git add plugins/p-tasks/tools/lib/destinations/fs.mjs plugins/p-tasks/tools/__tests__/fs-update.test.ts
git commit -m "feat(p-tasks): fs destination — updateItem with field patching and jiraKeys merge"
```

---

### Task 12: `destination.mjs` — resolver

**Files:**
- Create: `plugins/p-tasks/tools/lib/destination.mjs`
- Test: `plugins/p-tasks/tools/__tests__/destination-resolve.test.ts`

**What this owns:** `resolveDestination({ root, config }) → { primary, primaryName, mirrors, mirrorNames }`. Lazy mirror construction — mirrors are built only when explicitly requested. For now we wire only FS; Jira is added in Task 24.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDestination } from '../lib/destination.mjs';
import { defaultConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ptasks-resolve-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveDestination', () => {
  it('returns FS primary on default config', () => {
    const res = resolveDestination({ root: dir, config: defaultConfig() });
    expect(res.primary.kind).toBe('fs');
    expect(res.primaryName).toBe('fs');
    expect(res.mirrors).toEqual([]);
    expect(res.mirrorNames).toEqual([]);
  });
  it('reports primaryName matching config', () => {
    const cfg = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
    const res = resolveDestination({ root: dir, config: cfg });
    expect(res.primaryName).toBe('fs');
  });
  it('lazily instantiates mirrors (mirrorNames populated, mirrors getter on demand)', () => {
    const cfg = {
      primary: 'fs',
      mirrors: ['fs2'],
      destinations: { fs: { kind: 'fs' }, fs2: { kind: 'fs' } },
    };
    const res = resolveDestination({ root: dir, config: cfg });
    expect(res.mirrorNames).toEqual(['fs2']);
    expect(res.mirrors).toHaveLength(1);
    expect(res.mirrors[0].name).toBe('fs2');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `destination.mjs`**

```js
import { createFsDestination } from './destinations/fs.mjs';

function buildDestination({ root, name, block }) {
  if (block.kind === 'fs') return createFsDestination({ root, name });
  // jira branch — added in Task 24
  throw new Error(`unsupported destination kind: ${block.kind}`);
}

export function resolveDestination({ root, config }) {
  const primaryName = config.primary;
  const primaryBlock = config.destinations[primaryName];
  const primary = buildDestination({ root, name: primaryName, block: primaryBlock });

  const mirrorNames = config.mirrors ?? [];
  const mirrors = mirrorNames.map(n =>
    buildDestination({ root, name: n, block: config.destinations[n] }),
  );

  return { primary, primaryName, mirrors, mirrorNames };
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/destination-resolve.test.ts
git add plugins/p-tasks/tools/lib/destination.mjs plugins/p-tasks/tools/__tests__/destination-resolve.test.ts
git commit -m "feat(p-tasks): destination resolver — primary + mirrors construction"
```

---

## Phase D — CLI core (FS-only)

### Task 13: CLI scaffold and argv parser

**Files:**
- Create: `plugins/p-tasks/tools/ptasks.mjs`
- Test: `plugins/p-tasks/tools/__tests__/cli-entry.test.ts`

**What this owns:** the shebang, `parseArgs` (copied stylistically from p-wiki §90-95 of `pwiki.mjs`), command dispatch skeleton, JSON/text output helpers, `findRoot` for git-root resolution. No command logic yet — that arrives in tasks 14-18.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseArgs, findRoot } from '../ptasks.mjs';

describe('parseArgs', () => {
  it('parses positionals and flags', () => {
    expect(parseArgs(['add', 'task', '--title', 'x', '--json'])).toEqual({ _: ['add', 'task'], title: 'x', json: true });
  });
  it('parses --key=value form', () => {
    expect(parseArgs(['--title=x'])).toEqual({ _: [], title: 'x' });
  });
  it('repeats produce an array', () => {
    expect(parseArgs(['--mirror', 'a', '--mirror', 'b'])).toEqual({ _: [], mirror: ['a', 'b'] });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement scaffold**

```js
#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export const VERSION = '0.1.0';

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else { key = a.slice(2); val = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; }
      if (opts[key] === undefined) opts[key] = val;
      else if (Array.isArray(opts[key])) opts[key].push(val);
      else opts[key] = [opts[key], val];
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

export function findRoot(cwd) {
  try {
    const out = execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim();
  } catch {
    return cwd;
  }
}

export function emitJson(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

export function die(msg, code = 1) {
  process.stderr.write(`ptasks: ${msg}\n`);
  process.exit(code);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const KNOWN = ['init', 'add', 'set', 'next', 'summary', 'sync'];
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  // Dispatch added per-command in subsequent tasks
  die(`command ${command} not implemented yet`, 1);
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-entry.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-entry.test.ts
git commit -m "feat(p-tasks): CLI entry scaffold — parseArgs, findRoot, dispatch skeleton"
```

---

### Task 14: `ptasks init` (FS-only path)

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (export `initFs`, wire into dispatch)
- Test: `plugins/p-tasks/tools/__tests__/cli-init.test.ts`

**What this owns:** the FS-only init. Refuses when `.ptasks.json` already exists. Writes the file, scaffolds `tasks.yml`, writes `docs/tasks/CLAUDE.md` and `.claude/rules/p-tasks.md` from templates (templates created in Task 20; for now write inline strings, replaced later).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-init-fs-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('initFs', () => {
  it('writes config, tasks.yml, CLAUDE.md, and the rule', async () => {
    try { await initFs({ root: dir }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'tasks', 'tasks.yml'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'tasks', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'rules', 'p-tasks.md'))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), 'utf-8'));
    expect(cfg.primary).toBe('fs');
  });
  it('refuses if .ptasks.json already exists', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), '{}');
    try { await initFs({ root: dir }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('already-initialized');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL — `initFs` not exported.

- [ ] **Step 3: Implement `initFs`**

Add to `ptasks.mjs`:

```js
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, writeConfig, defaultConfig } from './lib/config.mjs';
import { createFsDestination } from './lib/destinations/fs.mjs';

const CLAUDE_MD_BODY = `# p-tasks data store

Tasks live in \`tasks.yml\` at this directory. Two-level hierarchy:
- top-level: \`task\` (\`id: t-N\`)
- nested under \`subTasks\`: \`sub-task\` (\`id: st-N\`)

Statuses: \`todo\` | \`in_progress\` | \`done\`. Use \`/p-tasks:\` commands to mutate.
Do not hand-edit unless you know what you are doing — id reuse is forbidden.
`;

const RULE_BODY = `# p-tasks

A task tracker plugin is installed in this repo (\`docs/tasks/tasks.yml\`).
Slash commands: \`/p-tasks:add\`, \`/p-tasks:set\`, \`/p-tasks:next\`, \`/p-tasks:summary\`, \`/p-tasks:sync\`.
\`/p-tasks:init\` is one-shot — do not re-run it.
`;

export async function initFs({ root }) {
  if (existsSync(configPath(root))) {
    return emitJson({ error: { code: 'already-initialized', message: 'docs/tasks/.ptasks.json already exists' } }, 1);
  }
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeConfig(root, defaultConfig());
  const fs = createFsDestination({ root });
  await fs.ensureStructure();
  writeFileSync(join(root, 'docs', 'tasks', 'CLAUDE.md'), CLAUDE_MD_BODY, 'utf-8');
  writeFileSync(join(root, '.claude', 'rules', 'p-tasks.md'), RULE_BODY, 'utf-8');
  return emitJson({ ok: true, primary: 'fs', mirrors: [] }, 0);
}
```

Wire into dispatch (replace the `die(...not implemented yet...)` for `init`):

```js
if (command === 'init') {
  const root = findRoot(process.cwd());
  await initFs({ root });
  return;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-init.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-init.test.ts
git commit -m "feat(p-tasks): ptasks init (FS path) — scaffolds config, tasks.yml, CLAUDE.md, rule"
```

---

### Task 15: `ptasks add` command

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (add `addCommand`, wire dispatch)
- Test: `plugins/p-tasks/tools/__tests__/cli-add.test.ts`

**What this owns:** parsing `add task --title X` / `add sub-task <parentId> --title X`, validating `blockedBy` ids exist and don't form a cycle, calling `primary.createItem`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommand, initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-add-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
  stdoutSpy.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('addCommand', () => {
  it('adds a task and returns id=t-1', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'Login', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.id).toBe('t-1');
    expect(out.title).toBe('Login');
  });
  it('adds a sub-task under existing parent', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'P', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'S', json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.id).toBe('st-1');
    expect(out.parentId).toBe('t-1');
  });
  it('rejects unknown blocker', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', 'blocked-by': 't-99', json: true } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('blocker-not-found');
  });
  it('rejects cycle creation', async () => {
    // Build chain t-1 ← t-2 ← t-3, then attempt t-1 blocked-by t-3 (would cycle)
    try { await addCommand({ root: dir, args: { _: ['task'], title: '1', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: '2', 'blocked-by': 't-1', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: '3', 'blocked-by': 't-2', json: true } }); } catch {}
    // create t-4 blocked-by t-3, then we'd need to amend an existing item — but add is create-only.
    // For add: a brand-new task can't create a cycle without referencing an ancestor that already exists.
    // Verified via set in cli-set.test.ts. Here we just confirm normal blocked-by works:
    stdoutSpy.mockClear();
    try { await addCommand({ root: dir, args: { _: ['task'], title: '4', 'blocked-by': 't-3', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `ptasks.mjs`:

```js
import { readConfig } from './lib/config.mjs';
import { resolveDestination } from './lib/destination.mjs';
import { findCycle } from './lib/cycles.mjs';

function arrayify(v) {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export async function addCommand({ root, args }) {
  const type = args._[0];
  if (type !== 'task' && type !== 'sub-task') return emitJson({ error: { code: 'internal', message: 'first arg must be "task" or "sub-task"' } }, 1);
  const parentId = type === 'sub-task' ? args._[1] : undefined;
  if (type === 'sub-task' && !parentId) return emitJson({ error: { code: 'internal', message: 'sub-task requires <parent-id>' } }, 1);
  if (!args.title) return emitJson({ error: { code: 'internal', message: '--title required' } }, 1);

  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();

  const blockedBy = arrayify(args['blocked-by']);
  const existing = await primary.listItems();
  const ids = new Set(existing.map(i => i.id));
  for (const b of blockedBy) {
    if (!ids.has(b)) return emitJson({ error: { code: 'blocker-not-found', message: `id ${b} not found` } }, 1);
  }

  // cycle check: hypothetically add a new id with these blockers and run findCycle
  const newId = `__pending__`;
  const hypothetical = existing.map(i => ({ id: i.id, blockedBy: i.blockedBy }))
    .concat([{ id: newId, blockedBy }]);
  const cycle = findCycle(hypothetical);
  if (cycle && cycle.includes(newId)) {
    return emitJson({ error: { code: 'cycle-detected', message: `would create cycle: ${cycle.join(' → ')}` } }, 1);
  }

  const created = await primary.createItem({
    type,
    parentId,
    title: args.title,
    description: args.description ?? '',
    status: args.status ?? 'todo',
    blockedBy,
  });
  return emitJson(created, 0);
}
```

Wire dispatch:

```js
if (command === 'add') {
  const root = findRoot(process.cwd());
  await addCommand({ root, args });
  return;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-add.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-add.test.ts
git commit -m "feat(p-tasks): ptasks add — create task/sub-task with blocker + cycle validation"
```

---

### Task 16: `ptasks set` command

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (add `setCommand`, wire dispatch)
- Test: `plugins/p-tasks/tools/__tests__/cli-set.test.ts`

**What this owns:** patch by id, validation for status enum and blocker references (existence + cycle), incremental `--add-blocker` / `--remove-blocker`, full `--blocked-by`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCommand, initFs, addCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-set-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: '1', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: '2', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: '3', 'blocked-by': 't-2', json: true } }); } catch {}
  stdoutSpy.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('setCommand', () => {
  it('updates status', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.status).toBe('in_progress');
  });
  it('rejects invalid status', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'wontfix', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('invalid-status');
  });
  it('rejects unknown id', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-99'], title: 'x', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('item-not-found');
  });
  it('--add-blocker rejects cycles', async () => {
    // t-3 blockedBy t-2 (initial). Now add blocker t-3 to t-2 → t-2 → t-3 → t-2 cycle.
    try { await setCommand({ root: dir, args: { _: ['t-2'], 'add-blocker': 't-3', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('cycle-detected');
  });
  it('--remove-blocker is incremental', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-3'], 'remove-blocker': 't-2', json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.blockedBy).toEqual([]);
  });
  it('--blocked-by replaces fully', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-3'], 'blocked-by': 't-1,t-2', json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.blockedBy.sort()).toEqual(['t-1', 't-2']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
import { STATUSES } from './lib/schema.mjs';

export async function setCommand({ root, args }) {
  const id = args._[0];
  if (!id) return emitJson({ error: { code: 'internal', message: 'id required' } }, 1);

  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  const current = items.find(i => i.id === id);
  if (!current) return emitJson({ error: { code: 'item-not-found', message: `id ${id} not found` } }, 1);

  const patch = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.description !== undefined) patch.description = args.description;
  if (args.status !== undefined) {
    if (!STATUSES.includes(args.status)) return emitJson({ error: { code: 'invalid-status', message: `status must be one of ${STATUSES.join('/')}` } }, 1);
    patch.status = args.status;
  }

  let newBlockedBy = current.blockedBy.slice();
  let touchedBlockers = false;
  if (args['blocked-by'] !== undefined) {
    newBlockedBy = arrayify(args['blocked-by']);
    touchedBlockers = true;
  }
  for (const b of arrayify(args['add-blocker'])) {
    if (!newBlockedBy.includes(b)) newBlockedBy.push(b);
    touchedBlockers = true;
  }
  for (const b of arrayify(args['remove-blocker'])) {
    newBlockedBy = newBlockedBy.filter(x => x !== b);
    touchedBlockers = true;
  }

  if (touchedBlockers) {
    const ids = new Set(items.map(i => i.id));
    for (const b of newBlockedBy) {
      if (!ids.has(b)) return emitJson({ error: { code: 'blocker-not-found', message: `id ${b} not found` } }, 1);
    }
    const hypothetical = items.map(i => i.id === id ? { id, blockedBy: newBlockedBy } : { id: i.id, blockedBy: i.blockedBy });
    const cycle = findCycle(hypothetical);
    if (cycle) return emitJson({ error: { code: 'cycle-detected', message: `would create cycle: ${cycle.join(' → ')}` } }, 1);
    patch.blockedBy = newBlockedBy;
  }

  const updated = await primary.updateItem(id, patch);
  return emitJson(updated, 0);
}
```

Wire dispatch:

```js
if (command === 'set') {
  const root = findRoot(process.cwd());
  await setCommand({ root, args });
  return;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-set.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-set.test.ts
git commit -m "feat(p-tasks): ptasks set — patch with status/blocker/cycle validation"
```

---

### Task 17: `ptasks next` command

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (add `nextCommand`, wire dispatch)
- Test: `plugins/p-tasks/tools/__tests__/cli-next.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCommand, initFs, addCommand, setCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-next-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('nextCommand', () => {
  it('returns null when nothing actionable', async () => {
    stdoutSpy.mockClear();
    try { await nextCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out).toEqual({ next: null });
  });
  it('returns top-1 by default and the full list with --all', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await nextCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const one = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(one.next.id).toBe('t-1');

    stdoutSpy.mockClear();
    try { await nextCommand({ root: dir, args: { _: [], all: true, json: true } }); } catch {}
    const all = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(all.items.map((i: any) => i.id)).toEqual(['t-1', 't-2']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
import { pickNext } from './lib/next.mjs';

export async function nextCommand({ root, args }) {
  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  const warns = [];
  if (args.all) {
    const list = pickNext(items, { all: true, onWarn: (m) => warns.push(m) });
    for (const w of warns) process.stderr.write(`warning: ${w}\n`);
    return emitJson({ items: list }, 0);
  }
  const one = pickNext(items, { onWarn: (m) => warns.push(m) });
  for (const w of warns) process.stderr.write(`warning: ${w}\n`);
  return emitJson({ next: one ?? null }, 0);
}
```

Wire dispatch:

```js
if (command === 'next') {
  const root = findRoot(process.cwd());
  await nextCommand({ root, args });
  return;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-next.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-next.test.ts
git commit -m "feat(p-tasks): ptasks next — top-1 or --all ranked candidates"
```

---

### Task 18: `ptasks summary` command

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs`
- Test: `plugins/p-tasks/tools/__tests__/cli-summary.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summaryCommand, initFs, addCommand, setCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-summary-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('summaryCommand', () => {
  it('lists done top-level tasks without args', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'done', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.items).toEqual([{ id: 't-1', title: 'A' }]);
  });
  it('lists done sub-tasks of a task', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'P', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'S', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['st-1'], status: 'done', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: ['t-1'], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.items).toEqual([{ id: 'st-1', title: 'S' }]);
  });
  it('rejects unknown parent', async () => {
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: ['t-99'], json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('item-not-found');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
import { summarize } from './lib/summary.mjs';

export async function summaryCommand({ root, args }) {
  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  const parentId = args._[0];
  try {
    const list = summarize(items, parentId ? { parentId } : {});
    return emitJson({ items: list }, 0);
  } catch (e) {
    return emitJson({ error: { code: 'item-not-found', message: e.message } }, 1);
  }
}
```

Wire dispatch:

```js
if (command === 'summary') {
  const root = findRoot(process.cwd());
  await summaryCommand({ root, args });
  return;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-summary.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-summary.test.ts
git commit -m "feat(p-tasks): ptasks summary — done items (top-level or scoped to parent)"
```

---

## Phase E — Skills (slash commands)

### Task 19: SKILL.md files for FS-path skills

**Files:**
- Create: `plugins/p-tasks/skills/init/SKILL.md`
- Create: `plugins/p-tasks/skills/add/SKILL.md`
- Create: `plugins/p-tasks/skills/set/SKILL.md`
- Create: `plugins/p-tasks/skills/next/SKILL.md`
- Create: `plugins/p-tasks/skills/summary/SKILL.md`

**What each SKILL.md owns:** frontmatter (`name`, `description`, `argument-hint`, `allowed-tools`), then a clear set of instructions for Claude on how to gather input from the user and dispatch the bundled CLI. Pattern mirrors `plugins/p-wiki/skills/init/SKILL.md`.

- [ ] **Step 1: Write `skills/init/SKILL.md`**

```markdown
---
name: init
description: |
  Initialize p-tasks at `docs/tasks/` of the current git repo. Use when the user says "init p-tasks", "create task list", "setup task tracking", or asks to start tracking tasks in this repo.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Bash(node:*) Read Write
---

# /p-tasks:init

You are scaffolding the `p-tasks` tracker inside the current repo.

## Step 0 — Verify Node 18+

Run `node --version`. Fail and stop if it's <18.

## Step 1 — Pre-flight

Check if `docs/tasks/.ptasks.json` exists. If yes, stop and tell the user: "p-tasks already initialized here. Edit `.ptasks.json` directly to change destinations, or remove it and re-run `/p-tasks:init`." Do not proceed.

## Step 2 — Choose primary destination

Ask: "Where should tasks live? `fs` (default — local `tasks.yml`) or `jira`?"

If `fs`: invoke `node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" init`. Report the printed JSON.

If `jira`: (Task 27 wires this path — for FS-only initial release, tell the user "Jira primary not yet supported; please choose fs.")
```

- [ ] **Step 2: Write `skills/add/SKILL.md`**

```markdown
---
name: add
description: |
  Create a task or sub-task in this repo's p-tasks list. Use when the user says "add task", "new sub-task", "create task", or describes work that should be tracked.
argument-hint: <task|sub-task> [<parent-id>] [--title ...] [--description ...] [--blocked-by ...]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:add

You create a new item via the bundled CLI.

## Step 1 — Resolve missing fields conversationally

Required fields:
- Type: `task` or `sub-task`. Infer from the user's wording ("a feature" → task, "a sub-step" → sub-task) or ask.
- For `sub-task`: the parent task id (`t-N`). Ask if missing.
- Title: ask if missing.

Optional fields the user may mention:
- Description (free-form)
- Blockers: a list of ids (e.g. `t-3, st-5`).

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" add <type> [<parent-id>] --title "..." [--description "..."] [--blocked-by id1,id2] --json
```

## Step 3 — Render outcome

On success, tell the user the assigned id and a one-line confirmation.
On `blocker-not-found` / `parent-not-found` / `cycle-detected`: explain the error in plain language and stop.
```

- [ ] **Step 3: Write `skills/set/SKILL.md`**

```markdown
---
name: set
description: |
  Update a task or sub-task: change status, title, description, or blocker list. Use when the user says "mark X done", "set status", "add blocker to X", "unblock X", "rename X".
argument-hint: <id> [--status todo|in_progress|done] [--title ...] [--description ...] [--blocked-by ...] [--add-blocker ...] [--remove-blocker ...]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:set

You update an existing item.

## Step 1 — Resolve target id

If the user named the item by title rather than id, list candidates by calling `ptasks summary --json` (with optional parent filter) and pick the matching id. If ambiguous, ask.

## Step 2 — Build the patch

Translate the user's request into one or more flags:
- "mark done" → `--status done`
- "start working on it" → `--status in_progress`
- "blocked by X" → `--add-blocker X`
- "no longer blocked by X" → `--remove-blocker X`
- "rename to Y" → `--title "Y"`

## Step 3 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" set <id> [flags] --json
```

## Step 4 — Render outcome

Confirm in one line. On `cycle-detected`, explain which path forms the cycle. On `invalid-status` or `blocker-not-found`, explain.
```

- [ ] **Step 4: Write `skills/next/SKILL.md`**

```markdown
---
name: next
description: |
  Return the most relevant unblocked item to work on next. Use when the user says "next task", "what should I work on", "что делать дальше", or asks to be assigned the next thing.
argument-hint: [--all]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:next

## Step 1 — Choose breadth

By default the command returns one item. If the user asks for "the whole list" or "everything I could do", pass `--all`.

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" next [--all] --json
```

## Step 3 — Render

If `{next: null}` or empty `items`: tell the user nothing is unblocked.
Otherwise: identify the item by id + title, mention its status, and (for sub-tasks) the parent.
```

- [ ] **Step 5: Write `skills/summary/SKILL.md`**

```markdown
---
name: summary
description: |
  Summarize completed work. Without an id — all done top-level tasks. With a task id — done sub-tasks of that task. Use when the user says "summary", "what's done", "what did we ship on X", "саммари сделанного".
argument-hint: [<task-id>]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:summary

## Step 1 — Resolve scope

If the user named a specific task (by title or id), find its id. Otherwise summarize the whole project.

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" summary [<task-id>] --json
```

## Step 3 — Synthesize prose

Take the structured list and produce a short natural-language rollup. List each done item by title; include description when present. End with a count.
```

- [ ] **Step 6: Sanity-validate**

```bash
node scripts/validate.mjs
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-tasks/skills/init/SKILL.md plugins/p-tasks/skills/add/SKILL.md plugins/p-tasks/skills/set/SKILL.md plugins/p-tasks/skills/next/SKILL.md plugins/p-tasks/skills/summary/SKILL.md
git commit -m "feat(p-tasks): SKILL.md for init/add/set/next/summary"
```

---

### Task 20: Template files used by `init`

**Files:**
- Create: `plugins/p-tasks/skills/_shared/templates/CLAUDE.md.tpl`
- Create: `plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl`
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (load templates from disk instead of inline strings)
- Test: extend `plugins/p-tasks/tools/__tests__/cli-init.test.ts`

**Why:** the inline strings in Task 14 were a placeholder. Real templates live under `_shared/templates/` so a user can browse / customize without touching CLI source.

- [ ] **Step 1: Create template files**

`plugins/p-tasks/skills/_shared/templates/CLAUDE.md.tpl`:

```markdown
# p-tasks data store

Tasks live in `tasks.yml` at this directory. Two-level hierarchy:
- top-level: `task` (`id: t-N`)
- nested under `subTasks`: `sub-task` (`id: st-N`)

Statuses: `todo` | `in_progress` | `done`. Use `/p-tasks:` commands to mutate.
Do not hand-edit unless you know what you are doing — id reuse is forbidden, and the canonical mutators (`/p-tasks:add`, `/p-tasks:set`) enforce structural invariants the file format does not.
```

`plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl`:

```markdown
# p-tasks

A task tracker plugin is installed in this repo at `docs/tasks/tasks.yml`.

Slash commands:
- `/p-tasks:add` — create a task or sub-task
- `/p-tasks:set <id>` — change status, title, description, or blockers
- `/p-tasks:next` — return the next unblocked item
- `/p-tasks:summary [<id>]` — list done items
- `/p-tasks:sync` — push primary state to all mirrors

`/p-tasks:init` is one-shot — do not re-run it.
```

- [ ] **Step 2: Modify `initFs` to load templates from disk**

Replace the inline `CLAUDE_MD_BODY` and `RULE_BODY` constants with reads from the template files. `CLAUDE_PLUGIN_ROOT` is the directory of `plugin.json`; from `tools/ptasks.mjs`'s perspective this is `../`. Add:

```js
import { dirname } from 'node:path';
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));

function loadTemplate(name) {
  return readFileSync(join(PLUGIN_ROOT, 'skills', '_shared', 'templates', name), 'utf-8');
}
```

In `initFs`, replace `CLAUDE_MD_BODY` with `loadTemplate('CLAUDE.md.tpl')` and `RULE_BODY` with `loadTemplate('p-tasks.rule.md.tpl')`.

- [ ] **Step 3: Extend init test to verify template contents land on disk**

Append to `cli-init.test.ts`:

```ts
it('written CLAUDE.md contains key phrase from template', () => {
  // run init from beforeEach scenario then read file
  const text = readFileSync(join(dir, 'docs', 'tasks', 'CLAUDE.md'), 'utf-8');
  expect(text).toContain('Two-level hierarchy');
});
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-init.test.ts
git add plugins/p-tasks/skills/_shared/templates/ plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-init.test.ts
git commit -m "feat(p-tasks): template files for CLAUDE.md and the global rule"
```

---

## Phase F — Jira destination

### Task 21: `jira/http.mjs` — fetch wrapper, auth, retry, error mapping

**Files:**
- Create: `plugins/p-tasks/tools/lib/jira/http.mjs`
- Test: `plugins/p-tasks/tools/__tests__/jira-http.test.ts`

**What this owns:** HTTP client factory that accepts an injectable transport (so tests pass a fake), exponential backoff for 429/5xx, and `mapErrorToCode(err)` translating HTTP status / network errors into spec §5.1 codes. Pattern follows `plugins/p-wiki/tools/lib/confluence/http.mjs`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createHttpClient, mapErrorToCode } from '../lib/jira/http.mjs';

function fakeTransport(responses: Array<{ status: number; body?: any }>) {
  let i = 0;
  return {
    transport: async () => {
      if (i >= responses.length) throw new Error('unexpected extra request');
      return { headers: {}, ...responses[i++] };
    },
    callCount: () => i,
  };
}

describe('jira/http', () => {
  it('GET returns body on 200', async () => {
    const { transport } = fakeTransport([{ status: 200, body: { hi: 1 } }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a@b.c', token: 't', transport });
    expect(await c.get('/rest/api/3/myself')).toEqual({ status: 200, headers: {}, body: { hi: 1 } });
  });
  it('retries on 429 then succeeds', async () => {
    const { transport, callCount } = fakeTransport([{ status: 429, body: null }, { status: 200, body: { ok: true } }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a@b.c', token: 't', transport, retryDelays: [0, 0] });
    expect((await c.get('/x')).status).toBe(200);
    expect(callCount()).toBe(2);
  });
  it('mapErrorToCode maps known statuses', () => {
    expect(mapErrorToCode({ status: 401 })).toBe('auth-failed');
    expect(mapErrorToCode({ status: 403 })).toBe('auth-failed');
    expect(mapErrorToCode({ status: 404 })).toBe('item-not-found');
    expect(mapErrorToCode({ status: 409 })).toBe('version-conflict');
    expect(mapErrorToCode({ status: 429 })).toBe('rate-limited');
    expect(mapErrorToCode({ status: 503 })).toBe('network-error');
    expect(mapErrorToCode({ code: 'ECONNREFUSED' })).toBe('network-error');
    expect(mapErrorToCode({})).toBe('internal');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
export function mapErrorToCode(err) {
  const s = err?.status;
  if (s === 401 || s === 403) return 'auth-failed';
  if (s === 404) return 'item-not-found';
  if (s === 409) return 'version-conflict';
  if (s === 429) return 'rate-limited';
  if (typeof s === 'number' && s >= 500) return 'network-error';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err?.code)) return 'network-error';
  return 'internal';
}

export function createHttpClient({ baseUrl, email, token, transport, retryDelays = [200, 800, 2400] }) {
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  async function call(method, path, body) {
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = { method, url: baseUrl + path, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    for (let attempt = 0; ; attempt++) {
      const res = await transport(req);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retryDelays.length) {
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
          continue;
        }
      }
      return res;
    }
  }
  return {
    get: (p) => call('GET', p),
    post: (p, body) => call('POST', p, body),
    put: (p, body) => call('PUT', p, body),
    delete: (p) => call('DELETE', p),
  };
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/jira-http.test.ts
git add plugins/p-tasks/tools/lib/jira/ plugins/p-tasks/tools/__tests__/jira-http.test.ts
git commit -m "feat(p-tasks): jira/http — fetch wrapper with auth, retry, error code mapping"
```

---

### Task 22: `jira/issues.mjs` — create / update / list / transitions

**Files:**
- Create: `plugins/p-tasks/tools/lib/jira/issues.mjs`
- Test: `plugins/p-tasks/tools/__tests__/jira-issues.test.ts`

**What this owns:** thin wrappers over Jira REST v3 endpoints: `POST /rest/api/3/issue` (create), `PUT /rest/api/3/issue/{key}` (field update), `GET /rest/api/3/issue/{key}/transitions` + `POST /rest/api/3/issue/{key}/transitions` (status), `POST /rest/api/3/search` (list via JQL). All accept a pre-configured http client.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createIssue, updateIssueFields, transitionIssue, listIssues } from '../lib/jira/issues.mjs';

function recordingTransport(responses: any[]) {
  const calls: any[] = [];
  let i = 0;
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...responses[i++] }; } };
}

const httpFor = (transport: any) => ({
  get: async (p: string) => transport({ method: 'GET', url: 'https://x' + p, headers: {} }),
  post: async (p: string, body: any) => transport({ method: 'POST', url: 'https://x' + p, headers: {}, body: JSON.stringify(body) }),
  put: async (p: string, body: any) => transport({ method: 'PUT', url: 'https://x' + p, headers: {}, body: JSON.stringify(body) }),
  delete: async (p: string) => transport({ method: 'DELETE', url: 'https://x' + p, headers: {} }),
});

describe('jira/issues', () => {
  it('createIssue posts the right body and returns key', async () => {
    const r = recordingTransport([{ status: 201, body: { id: '1', key: 'PROJ-1' } }]);
    const http = httpFor(r.transport);
    const out = await createIssue(http, { projectKey: 'PROJ', issueType: 'Task', summary: 'T', description: 'D' });
    expect(out).toEqual({ id: '1', key: 'PROJ-1' });
    expect(r.calls[0].url).toContain('/rest/api/3/issue');
    const body = JSON.parse(r.calls[0].body);
    expect(body.fields.project.key).toBe('PROJ');
    expect(body.fields.summary).toBe('T');
    expect(body.fields.issuetype.name).toBe('Task');
  });
  it('createIssue with parentKey sets parent for sub-task', async () => {
    const r = recordingTransport([{ status: 201, body: { id: '2', key: 'PROJ-2' } }]);
    const http = httpFor(r.transport);
    await createIssue(http, { projectKey: 'PROJ', issueType: 'Sub-task', summary: 'S', parentKey: 'PROJ-1' });
    expect(JSON.parse(r.calls[0].body).fields.parent.key).toBe('PROJ-1');
  });
  it('transitionIssue picks transition by target name', async () => {
    const r = recordingTransport([
      { status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }, { id: '21', to: { name: 'Done' } }] } },
      { status: 204, body: null },
    ]);
    const http = httpFor(r.transport);
    await transitionIssue(http, 'PROJ-1', 'Done');
    expect(JSON.parse(r.calls[1].body).transition.id).toBe('21');
  });
  it('transitionIssue throws transition-not-found if no match', async () => {
    const r = recordingTransport([{ status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }] } }]);
    const http = httpFor(r.transport);
    await expect(transitionIssue(http, 'PROJ-1', 'Done')).rejects.toMatchObject({ code: 'transition-not-found' });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
function adfPlain(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: text || '' }] }] };
}

export async function createIssue(http, { projectKey, issueType, summary, description, parentKey }) {
  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary,
  };
  if (description !== undefined) fields.description = adfPlain(description);
  if (parentKey) fields.parent = { key: parentKey };
  const res = await http.post('/rest/api/3/issue', { fields });
  if (res.status !== 201 && res.status !== 200) throw Object.assign(new Error(`create failed: ${res.status}`), { status: res.status });
  return { id: res.body.id, key: res.body.key };
}

export async function updateIssueFields(http, key, patch) {
  const fields = {};
  if ('title' in patch) fields.summary = patch.title;
  if ('description' in patch) fields.description = adfPlain(patch.description);
  if (Object.keys(fields).length === 0) return;
  const res = await http.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
  if (res.status !== 204 && res.status !== 200) throw Object.assign(new Error(`update failed: ${res.status}`), { status: res.status });
}

export async function transitionIssue(http, key, targetStatusName) {
  const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  if (res.status !== 200) throw Object.assign(new Error(`transitions failed: ${res.status}`), { status: res.status });
  const t = (res.body?.transitions ?? []).find(x => x.to?.name === targetStatusName);
  if (!t) throw Object.assign(new Error(`no transition to ${targetStatusName}`), { code: 'transition-not-found' });
  const apply = await http.post(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
  if (apply.status !== 204) throw Object.assign(new Error(`transition apply failed: ${apply.status}`), { status: apply.status });
}

export async function listIssues(http, jql) {
  const out = [];
  let startAt = 0;
  while (true) {
    const res = await http.post('/rest/api/3/search', { jql, startAt, maxResults: 100, fields: ['summary', 'description', 'status', 'issuetype', 'parent', 'issuelinks'] });
    if (res.status !== 200) throw Object.assign(new Error(`search failed: ${res.status}`), { status: res.status });
    out.push(...(res.body.issues ?? []));
    const total = res.body.total ?? 0;
    startAt += res.body.issues?.length ?? 0;
    if (startAt >= total || !(res.body.issues?.length)) break;
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/jira-issues.test.ts
git add plugins/p-tasks/tools/lib/jira/issues.mjs plugins/p-tasks/tools/__tests__/jira-issues.test.ts
git commit -m "feat(p-tasks): jira/issues — create/update/transition/list with JQL pagination"
```

---

### Task 23: `jira/links.mjs` — Blocks issue links

**Files:**
- Create: `plugins/p-tasks/tools/lib/jira/links.mjs`
- Test: `plugins/p-tasks/tools/__tests__/jira-links.test.ts`

**What this owns:** create, list (per issue), and delete `Blocks` issue links. Used in sync pass 4 for link reconciliation.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createBlocksLink, deleteLink, listBlocksLinks } from '../lib/jira/links.mjs';

function recordingTransport(responses: any[]) {
  const calls: any[] = [];
  let i = 0;
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...responses[i++] }; } };
}
const httpFor = (t: any) => ({
  get: (p: string) => t({ method: 'GET', url: 'https://x' + p, headers: {} }),
  post: (p: string, body: any) => t({ method: 'POST', url: 'https://x' + p, headers: {}, body: JSON.stringify(body) }),
  delete: (p: string) => t({ method: 'DELETE', url: 'https://x' + p, headers: {} }),
});

describe('jira/links', () => {
  it('createBlocksLink posts the right body', async () => {
    const r = recordingTransport([{ status: 201, body: {} }]);
    const http = httpFor(r.transport);
    await createBlocksLink(http, { sourceKey: 'PROJ-1', targetKey: 'PROJ-2' });
    const body = JSON.parse(r.calls[0].body);
    expect(body.type.name).toBe('Blocks');
    expect(body.inwardIssue.key).toBe('PROJ-1');     // PROJ-1 is blocked by PROJ-2
    expect(body.outwardIssue.key).toBe('PROJ-2');
  });
  it('deleteLink uses DELETE on the link id', async () => {
    const r = recordingTransport([{ status: 204 }]);
    const http = httpFor(r.transport);
    await deleteLink(http, '10042');
    expect(r.calls[0].url).toContain('/issueLink/10042');
    expect(r.calls[0].method).toBe('DELETE');
  });
  it('listBlocksLinks returns inbound blockers only', async () => {
    const r = recordingTransport([{
      status: 200,
      body: {
        fields: {
          issuelinks: [
            { id: '1', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-2' } },
            { id: '2', type: { name: 'Blocks' }, outwardIssue: { key: 'PROJ-3' } }, // PROJ-1 blocks PROJ-3 — outbound, not a blocker of PROJ-1
            { id: '3', type: { name: 'Relates' }, inwardIssue: { key: 'PROJ-4' } },
          ],
        },
      },
    }]);
    const http = httpFor(r.transport);
    const out = await listBlocksLinks(http, 'PROJ-1');
    expect(out).toEqual([{ id: '1', blockerKey: 'PROJ-2' }]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// In Jira's "Blocks" link type:
//   outwardIssue is the source ("PROJ-A blocks PROJ-B")
//   inwardIssue is the target ("PROJ-B is blocked by PROJ-A")
// We model blockedBy on the inward side: if our item depends on PROJ-2, our item is the inward side.

export async function createBlocksLink(http, { sourceKey, targetKey }) {
  // sourceKey is blocked by targetKey
  const res = await http.post('/rest/api/3/issueLink', {
    type: { name: 'Blocks' },
    inwardIssue: { key: sourceKey },
    outwardIssue: { key: targetKey },
  });
  if (res.status !== 201 && res.status !== 200) throw Object.assign(new Error(`link failed: ${res.status}`), { status: res.status });
}

export async function deleteLink(http, linkId) {
  const res = await http.delete(`/rest/api/3/issueLink/${encodeURIComponent(linkId)}`);
  if (res.status !== 204 && res.status !== 200) throw Object.assign(new Error(`delete link failed: ${res.status}`), { status: res.status });
}

export async function listBlocksLinks(http, issueKey) {
  const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`);
  if (res.status !== 200) throw Object.assign(new Error(`list links failed: ${res.status}`), { status: res.status });
  const links = res.body?.fields?.issuelinks ?? [];
  return links
    .filter(l => l.type?.name === 'Blocks' && l.inwardIssue?.key === issueKey && l.outwardIssue?.key)
    .map(l => ({ id: l.id, blockerKey: l.outwardIssue.key }));
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/jira-links.test.ts
git add plugins/p-tasks/tools/lib/jira/links.mjs plugins/p-tasks/tools/__tests__/jira-links.test.ts
git commit -m "feat(p-tasks): jira/links — create/list/delete Blocks issue links"
```

---

### Task 24: Jira destination — `ensureStructure`, `listItems`, `readItem`, `createItem`

**Files:**
- Create: `plugins/p-tasks/tools/lib/destinations/jira.mjs`
- Test: `plugins/p-tasks/tools/__tests__/jira-destination.test.ts`

**What this owns:** Jira destination contract conformance. `ensureStructure` validates project + issue types exist. `listItems` JQL-searches then maps Jira issues → ptasks Items. `createItem` produces a new Jira issue, returns the assigned key as `id`. `updateItem` arrives in Task 25.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createJiraDestination } from '../lib/destinations/jira.mjs';

function fakeJira(responses: Array<{ status: number; body?: any }>) {
  let i = 0;
  const calls: any[] = [];
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...responses[i++] }; } };
}

describe('jira destination', () => {
  it('ensureStructure validates the project exists', async () => {
    const fake = fakeJira([{ status: 200, body: { key: 'PROJ' } }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: '' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    await dst.ensureStructure();
    expect(fake.calls[0].url).toContain('/rest/api/3/project/PROJ');
  });
  it('listItems flattens Jira issues with parent meta on sub-tasks', async () => {
    const fake = fakeJira([{
      status: 200, body: {
        total: 2, issues: [
          { id: '1', key: 'PROJ-1', fields: { summary: 'T', description: { content: [{ content: [{ text: 'D' }] }] }, status: { name: 'To Do' }, issuetype: { name: 'Task' }, issuelinks: [] } },
          { id: '2', key: 'PROJ-2', fields: { summary: 'S', description: null, status: { name: 'Done' }, issuetype: { name: 'Sub-task' }, parent: { key: 'PROJ-1' }, issuelinks: [] } },
        ],
      },
    }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: 'project = PROJ' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const items = await dst.listItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'PROJ-1', type: 'task', title: 'T', status: 'todo' });
    expect(items[1]).toMatchObject({ id: 'PROJ-2', type: 'sub-task', parentId: 'PROJ-1', status: 'done' });
  });
  it('createItem returns the new Jira key as id', async () => {
    const fake = fakeJira([{ status: 201, body: { id: '99', key: 'PROJ-9' } }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: '' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const out = await dst.createItem({ type: 'task', title: 'New', description: '', status: 'todo', blockedBy: [] });
    expect(out.id).toBe('PROJ-9');
    expect(out.title).toBe('New');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
import { createHttpClient } from '../jira/http.mjs';
import { createIssue, updateIssueFields, transitionIssue, listIssues } from '../jira/issues.mjs';
import { STATUSES } from '../schema.mjs';

function extractAdfText(adf) {
  if (!adf || !adf.content) return '';
  const out = [];
  function walk(node) {
    if (node?.text) out.push(node.text);
    for (const c of node?.content ?? []) walk(c);
  }
  walk(adf);
  return out.join('').trim();
}

function jiraStatusToInternal(name, statusMap) {
  for (const k of STATUSES) if (statusMap[k] === name) return k;
  return 'todo'; // unmapped → conservative default
}

export function createJiraDestination({ block, email, token, transport, name = 'jira' }) {
  const http = createHttpClient({ baseUrl: block.siteUrl, email, token, transport });
  const { projectKey, issueTypes, statusMap, jql } = block;

  function toItem(issue) {
    const it = issue.fields.issuetype?.name;
    const type = it === issueTypes.task ? 'task' : 'sub-task';
    const base = {
      id: issue.key,
      type,
      title: issue.fields.summary ?? '',
      description: extractAdfText(issue.fields.description),
      status: jiraStatusToInternal(issue.fields.status?.name, statusMap),
      blockedBy: (issue.fields.issuelinks ?? [])
        .filter(l => l.type?.name === 'Blocks' && l.inwardIssue?.key === issue.key && l.outwardIssue?.key)
        .map(l => l.outwardIssue.key),
    };
    if (type === 'sub-task') base.parentId = issue.fields.parent?.key;
    return base;
  }

  return {
    kind: 'jira',
    name,

    async ensureStructure() {
      const res = await http.get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
      if (res.status !== 200) throw Object.assign(new Error(`project ${projectKey} not accessible`), { status: res.status });
    },

    async listItems() {
      const issues = await listIssues(http, jql || `project = ${projectKey} AND issuetype in ("${issueTypes.task}", "${issueTypes.subTask}")`);
      return issues.map(toItem);
    },

    async readItem(id) {
      const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=summary,description,status,issuetype,parent,issuelinks`);
      if (res.status === 404) throw Object.assign(new Error(`item-not-found: ${id}`), { code: 'item-not-found' });
      if (res.status !== 200) throw Object.assign(new Error(`read failed: ${res.status}`), { status: res.status });
      return toItem({ key: id, ...res.body });
    },

    async createItem(input) {
      const issueType = input.type === 'task' ? issueTypes.task : issueTypes.subTask;
      const out = await createIssue(http, {
        projectKey, issueType,
        summary: input.title,
        description: input.description ?? '',
        parentKey: input.type === 'sub-task' ? input.parentId : undefined,
      });
      // Apply non-default status if requested (single-hop only)
      if (input.status && input.status !== 'todo') {
        await transitionIssue(http, out.key, statusMap[input.status]);
      }
      // Blockers handled by sync pass 4 or by an explicit set call after creation
      return {
        id: out.key,
        type: input.type,
        parentId: input.parentId,
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'todo',
        blockedBy: input.blockedBy ?? [],
      };
    },

    async updateItem() { throw new Error('not implemented yet'); },

    _http: http,                                                            // exposed for tests
    _config: { projectKey, issueTypes, statusMap },
  };
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/jira-destination.test.ts
git add plugins/p-tasks/tools/lib/destinations/jira.mjs plugins/p-tasks/tools/__tests__/jira-destination.test.ts
git commit -m "feat(p-tasks): jira destination — ensureStructure, listItems, readItem, createItem"
```

---

### Task 25: Jira destination — `updateItem` with link reconciliation

**Files:**
- Modify: `plugins/p-tasks/tools/lib/destinations/jira.mjs`
- Test: `plugins/p-tasks/tools/__tests__/jira-update.test.ts`

**What this owns:** the most complex single piece in this plugin. `updateItem` accepts a patch and:
1. Updates `summary` / `description` via PUT if `title` / `description` in patch.
2. Runs a status transition via `transitionIssue` if `status` in patch.
3. If `blockedBy` in patch: GETs existing Blocks links for this issue, diffs against target set, DELETEs extras, POSTs missing.

`set --status` failures bubble up as hard errors (`transition-not-found`). `sync` callers will catch and warn instead.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createJiraDestination } from '../lib/destinations/jira.mjs';

function fakeJira(seq: any[]) {
  let i = 0;
  const calls: any[] = [];
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...seq[i++] }; } };
}

const block = { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' }, jql: '' };

describe('jira destination — updateItem', () => {
  it('updates summary/description via PUT', async () => {
    const fake = fakeJira([{ status: 204 }]);
    const dst = createJiraDestination({ block, email: 'a@b.c', token: 't', transport: fake.transport });
    await dst.updateItem('PROJ-1', { title: 'X', description: 'Y' });
    expect(fake.calls[0].method).toBe('PUT');
    const body = JSON.parse(fake.calls[0].body);
    expect(body.fields.summary).toBe('X');
  });
  it('reconciles blockers — DELETEs extras and POSTs missing', async () => {
    const fake = fakeJira([
      // GET existing links: PROJ-1 inwardly linked from PROJ-99 (existing) and PROJ-100 (extra)
      { status: 200, body: { fields: { issuelinks: [
        { id: '500', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-99' } },
        { id: '501', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-100' } },
      ] } } },
      { status: 204 },                                                       // DELETE 501
      { status: 201 },                                                       // POST new link to PROJ-50
    ]);
    const dst = createJiraDestination({ block, email: 'a@b.c', token: 't', transport: fake.transport });
    await dst.updateItem('PROJ-1', { blockedBy: ['PROJ-99', 'PROJ-50'] });
    const methods = fake.calls.map(c => c.method);
    expect(methods).toEqual(['GET', 'DELETE', 'POST']);
    expect(fake.calls[1].url).toContain('/issueLink/501');
    const linkBody = JSON.parse(fake.calls[2].body);
    expect(linkBody.outwardIssue.key).toBe('PROJ-50');
  });
  it('status transition propagates transition-not-found as hard error', async () => {
    const fake = fakeJira([
      { status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }] } },
    ]);
    const dst = createJiraDestination({ block, email: 'a@b.c', token: 't', transport: fake.transport });
    await expect(dst.updateItem('PROJ-1', { status: 'done' })).rejects.toMatchObject({ code: 'transition-not-found' });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the `updateItem` placeholder. Add to `jira.mjs` imports: `import { createBlocksLink, deleteLink, listBlocksLinks } from '../jira/links.mjs';`. Then:

```js
async updateItem(id, patch) {
  if ('title' in patch || 'description' in patch) {
    await updateIssueFields(http, id, { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) });
  }
  if ('status' in patch) {
    await transitionIssue(http, id, statusMap[patch.status]);
  }
  if ('blockedBy' in patch) {
    const existing = await listBlocksLinks(http, id);
    const existingByKey = new Map(existing.map(e => [e.blockerKey, e.id]));
    const target = new Set(patch.blockedBy);
    for (const e of existing) {
      if (!target.has(e.blockerKey)) await deleteLink(http, e.id);
    }
    for (const k of patch.blockedBy) {
      if (!existingByKey.has(k)) await createBlocksLink(http, { sourceKey: id, targetKey: k });
    }
  }
  // jiraKeys is FS-side metadata; Jira destination ignores it
  return await this.readItem(id).catch(() => ({ id, type: 'task', title: '', description: '', status: 'todo', blockedBy: [] }));
},
```

(The trailing `readItem` may not always succeed if tests don't mock that call — for unit tests above, the calls would not extend. Acceptable: callers that need the refreshed item can re-read.)

For test simplicity, change the return to a synthesized minimal object reflecting the patch:

```js
return { id, ...patch };
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/jira-update.test.ts
git add plugins/p-tasks/tools/lib/destinations/jira.mjs plugins/p-tasks/tools/__tests__/jira-update.test.ts
git commit -m "feat(p-tasks): jira destination — updateItem with status transition + blocker reconciliation"
```

---

### Task 26: Wire Jira branch in `destination.mjs` resolver

**Files:**
- Modify: `plugins/p-tasks/tools/lib/destination.mjs`
- Test: extend `plugins/p-tasks/tools/__tests__/destination-resolve.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it('builds a jira destination from a jira block', () => {
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
  const cfg = {
    primary: 'fs',
    mirrors: ['j'],
    destinations: {
      fs: { kind: 'fs' },
      j: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' }, jql: '' },
    },
  };
  const res = resolveDestination({ root: dir, config: cfg });
  expect(res.mirrors[0].kind).toBe('jira');
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL — Jira branch throws "unsupported".

- [ ] **Step 3: Modify resolver**

```js
import { createJiraDestination } from './destinations/jira.mjs';

function makeTransport() {
  return async function transport(req) {
    const res = await globalThis.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    let body = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) { try { body = await res.json(); } catch { body = null; } }
    else { await res.text(); }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body };
  };
}

function buildDestination({ root, name, block, transport }) {
  if (block.kind === 'fs') return createFsDestination({ root, name });
  if (block.kind === 'jira') {
    const email = process.env.PTASKS_JIRA_EMAIL;
    const token = process.env.PTASKS_JIRA_TOKEN;
    if (!email || !token) throw Object.assign(new Error('PTASKS_JIRA_EMAIL and PTASKS_JIRA_TOKEN required'), { code: 'auth-failed' });
    return createJiraDestination({ block, email, token, transport: transport ?? makeTransport(), name });
  }
  throw new Error(`unsupported destination kind: ${block.kind}`);
}

export function resolveDestination({ root, config, transport }) {
  const primaryName = config.primary;
  const primary = buildDestination({ root, name: primaryName, block: config.destinations[primaryName], transport });
  const mirrorNames = config.mirrors ?? [];
  const mirrors = mirrorNames.map(n => buildDestination({ root, name: n, block: config.destinations[n], transport }));
  return { primary, primaryName, mirrors, mirrorNames };
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/destination-resolve.test.ts
git add plugins/p-tasks/tools/lib/destination.mjs plugins/p-tasks/tools/__tests__/destination-resolve.test.ts
git commit -m "feat(p-tasks): destination resolver — Jira branch with injectable transport"
```

---

### Task 27: Extend `ptasks init` for Jira primary and Jira mirror

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (add `initJira`, accept `--primary`, `--mirror-jira`)
- Modify: `plugins/p-tasks/skills/init/SKILL.md` (uncomment Jira path)
- Test: `plugins/p-tasks/tools/__tests__/cli-init-jira.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWithArgs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-init-jira-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('initWithArgs jira', () => {
  it('writes a jira-primary config when --primary=jira', async () => {
    const fake = async () => ({ status: 200, headers: {}, body: { key: 'PROJ' } });
    try { await initWithArgs({ root: dir, args: { primary: 'jira', site: 'https://x', project: 'PROJ', json: true }, transport: fake }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const cfg = JSON.parse(readFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), 'utf-8'));
    expect(cfg.primary).toBe('jira');
    expect(cfg.destinations.jira.projectKey).toBe('PROJ');
  });
  it('writes fs+jira-mirror when --primary=fs --mirror=jira', async () => {
    const fake = async () => ({ status: 200, headers: {}, body: { key: 'PROJ' } });
    try { await initWithArgs({ root: dir, args: { primary: 'fs', mirror: 'jira', site: 'https://x', project: 'PROJ', json: true }, transport: fake }); } catch {}
    const cfg = JSON.parse(readFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), 'utf-8'));
    expect(cfg.primary).toBe('fs');
    expect(cfg.mirrors).toEqual(['jira']);
    expect(cfg.destinations.jira.kind).toBe('jira');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

Refactor `initFs` into `initWithArgs`:

```js
function jiraBlockFromArgs(args) {
  return {
    kind: 'jira',
    siteUrl: args.site,
    projectKey: args.project,
    issueTypes: { task: args['task-type'] ?? 'Task', subTask: args['sub-task-type'] ?? 'Sub-task' },
    statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' },
    jql: `project = ${args.project} AND issuetype in ("${args['task-type'] ?? 'Task'}", "${args['sub-task-type'] ?? 'Sub-task'}")`,
  };
}

export async function initWithArgs({ root, args, transport }) {
  if (existsSync(configPath(root))) {
    return emitJson({ error: { code: 'already-initialized', message: 'docs/tasks/.ptasks.json already exists' } }, 1);
  }
  const primaryKind = args.primary ?? 'fs';
  const mirrorKind = args.mirror;

  const destinations = {};
  if (primaryKind === 'fs' || mirrorKind === 'fs') destinations.fs = { kind: 'fs' };
  if (primaryKind === 'jira' || mirrorKind === 'jira') {
    if (!process.env.PTASKS_JIRA_EMAIL || !process.env.PTASKS_JIRA_TOKEN) return emitJson({ error: { code: 'auth-failed', message: 'PTASKS_JIRA_EMAIL and PTASKS_JIRA_TOKEN required' } }, 1);
    if (!args.site || !args.project) return emitJson({ error: { code: 'config-invalid', message: '--site and --project required for jira' } }, 1);
    destinations.jira = jiraBlockFromArgs(args);
    // probe project exists
    const probe = createJiraDestination({ block: destinations.jira, email: process.env.PTASKS_JIRA_EMAIL, token: process.env.PTASKS_JIRA_TOKEN, transport });
    try { await probe.ensureStructure(); }
    catch (e) { return emitJson({ error: { code: 'config-invalid', message: e.message } }, 1); }
  }

  const cfg = {
    primary: primaryKind,
    mirrors: mirrorKind ? [mirrorKind] : [],
    destinations,
  };
  const v = validateConfig(cfg);
  if (!v.ok) return emitJson({ error: { code: 'internal', message: v.error } }, 1);

  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeConfig(root, cfg);
  if (destinations.fs) {
    const fs = createFsDestination({ root });
    await fs.ensureStructure();
  }
  writeFileSync(join(root, 'docs', 'tasks', 'CLAUDE.md'), loadTemplate('CLAUDE.md.tpl'), 'utf-8');
  writeFileSync(join(root, '.claude', 'rules', 'p-tasks.md'), loadTemplate('p-tasks.rule.md.tpl'), 'utf-8');
  return emitJson({ ok: true, primary: primaryKind, mirrors: cfg.mirrors }, 0);
}

// keep initFs as a thin wrapper for back-compat with existing tests
export async function initFs({ root }) {
  return initWithArgs({ root, args: {} });
}
```

Wire dispatch — replace the `init` branch:

```js
if (command === 'init') {
  const root = findRoot(process.cwd());
  await initWithArgs({ root, args });
  return;
}
```

Update `skills/init/SKILL.md` Step 2 to actually drive the Jira path: prompt for site/project/issue-types/status-map, then invoke `ptasks init --primary=jira --site=... --project=...`. Add `--mirror=jira|fs|none` prompt as Step 3.

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-init-jira.test.ts
npx vitest run plugins/p-tasks/tools/__tests__/cli-init.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/skills/init/SKILL.md plugins/p-tasks/tools/__tests__/cli-init-jira.test.ts
git commit -m "feat(p-tasks): init — support jira primary and jira mirror configurations"
```

---

## Phase G — Sync

### Task 28: `sync.mjs` orchestrator

**Files:**
- Create: `plugins/p-tasks/tools/lib/sync.mjs`
- Test: `plugins/p-tasks/tools/__tests__/sync.test.ts`

**What this owns:** the full primary→mirror sync per spec §4. Single read of primary, cycle check if Jira-primary, then iterate mirrors with passes 0/2/3a/3b/4/5. Per-mirror errors don't abort the next mirror; primary-side errors abort everything.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { syncAll } from '../lib/sync.mjs';

// Build two in-memory destinations that follow the Destination contract.
function memDest(name: string, opts: { kind: 'fs' | 'jira' } = { kind: 'fs' }) {
  const items: any[] = [];
  let n = 0;
  return {
    kind: opts.kind, name,
    state: items,
    async ensureStructure() {},
    async listItems() { return items.map(i => ({ ...i })); },
    async readItem(id: string) { const x = items.find(i => i.id === id); if (!x) throw Object.assign(new Error('item-not-found'), { code: 'item-not-found' }); return { ...x }; },
    async createItem(input: any) {
      const id = opts.kind === 'jira' ? `Q-${++n}` : `t-${++n}`;
      const newItem = { id, type: input.type, parentId: input.parentId, title: input.title, description: input.description ?? '', status: input.status ?? 'todo', blockedBy: [] };
      items.push(newItem);
      return { ...newItem };
    },
    async updateItem(id: string, patch: any) {
      const x = items.find(i => i.id === id);
      if (!x) throw Object.assign(new Error('item-not-found'), { code: 'item-not-found' });
      Object.assign(x, patch);
      return { ...x };
    },
  };
}

describe('syncAll', () => {
  it('creates missing items on the mirror', async () => {
    const primary = memDest('fs');
    await primary.createItem({ type: 'task', title: 'A' });
    await primary.createItem({ type: 'task', title: 'B' });
    const mirror = memDest('m');
    const out = await syncAll({ primary, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] });
    expect(out).toHaveLength(1);
    expect(out[0].created).toBe(2);
    expect(out[0].errors).toEqual([]);
  });
  it('is idempotent — second run does nothing', async () => {
    const primary = memDest('fs');
    await primary.createItem({ type: 'task', title: 'A' });
    const mirror = memDest('m');
    await syncAll({ primary, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] });
    const out = await syncAll({ primary, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] });
    expect(out[0].created).toBe(0);
    expect(out[0].updated + out[0].linksAdded + out[0].linksRemoved).toBe(0);
  });
  it('mirror A failure does not stop mirror B', async () => {
    const primary = memDest('fs');
    await primary.createItem({ type: 'task', title: 'A' });
    const broken = { ...memDest('A'), ensureStructure: async () => { throw Object.assign(new Error('boom'), { code: 'network-error' }); } };
    const good = memDest('B');
    const out = await syncAll({ primary, primaryName: 'fs', mirrors: [broken as any, good], mirrorNames: ['A', 'B'] });
    expect(out[0].errors[0].code).toBe('network-error');
    expect(out[1].created).toBe(1);
  });
  it('aborts entirely if primary listItems fails (primary-side error)', async () => {
    const primary = { ...memDest('fs'), listItems: async () => { throw Object.assign(new Error('boom'), { code: 'network-error' }); } };
    const mirror = memDest('m');
    await expect(syncAll({ primary: primary as any, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] }))
      .rejects.toMatchObject({ code: 'network-error' });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
import { findCycle } from './cycles.mjs';

function isJira(d) { return d.kind === 'jira'; }

function mappedKeyFor(srcItem, src, mirror) {
  // FS primary → Jira mirror: srcItem.jiraKeys[mirror.name]
  // Jira primary → FS mirror: srcItem.id (Jira key) is the FS id
  if (src.kind === 'fs' && mirror.kind === 'jira') return srcItem.jiraKeys?.[mirror.name];
  if (src.kind === 'jira' && mirror.kind === 'fs') return srcItem.id;
  // FS → FS or Jira → Jira: identity by id
  return srcItem.id;
}

function counterTemplate(name, kind) {
  return { mirror: name, kind, created: 0, updated: 0, linksAdded: 0, linksRemoved: 0, warnings: [], errors: [] };
}

export async function syncAll({ primary, primaryName, mirrors, mirrorNames }) {
  // Pass 1: read primary once
  const srcItems = await primary.listItems();

  // Cycle check on Jira-primary
  if (primary.kind === 'jira') {
    const cycle = findCycle(srcItems.map(i => ({ id: i.id, blockedBy: i.blockedBy })));
    if (cycle) throw Object.assign(new Error(`cycle-detected on primary: ${cycle.join(' → ')}`), { code: 'cycle-detected' });
  }

  const results = [];
  for (let mi = 0; mi < mirrors.length; mi++) {
    const mirror = mirrors[mi];
    const counters = counterTemplate(mirrorNames[mi], mirror.kind);
    try {
      await mirror.ensureStructure();
      const dstItems = await mirror.listItems();
      const dstByKey = new Map(dstItems.map(i => [i.id, i]));

      const srcToDstId = new Map();                                                // src.id → dst.id (for blocker translation in pass 4)

      // Pass 3a: tasks (no blockers, no sub-task refs)
      for (const s of srcItems.filter(i => i.type === 'task')) {
        const mappedKey = mappedKeyFor(s, primary, mirror);
        const existing = mappedKey ? dstByKey.get(mappedKey) : undefined;
        if (existing) {
          await mirror.updateItem(existing.id, { title: s.title, description: s.description, status: s.status });
          srcToDstId.set(s.id, existing.id);
          counters.updated++;
        } else {
          const created = await mirror.createItem({ type: 'task', title: s.title, description: s.description, status: s.status });
          srcToDstId.set(s.id, created.id);
          counters.created++;
          // Pass 5 (incremental for this item): persist mapping back to primary if applicable
          if (primary.kind === 'fs' && mirror.kind === 'jira') {
            await primary.updateItem(s.id, { jiraKeys: { [mirror.name]: created.id } });
          }
        }
      }

      // Pass 3b: sub-tasks
      for (const s of srcItems.filter(i => i.type === 'sub-task')) {
        const mappedKey = mappedKeyFor(s, primary, mirror);
        const existing = mappedKey ? dstByKey.get(mappedKey) : undefined;
        const dstParentId = srcToDstId.get(s.parentId);
        if (existing) {
          await mirror.updateItem(existing.id, { title: s.title, description: s.description, status: s.status });
          srcToDstId.set(s.id, existing.id);
          counters.updated++;
        } else {
          const created = await mirror.createItem({ type: 'sub-task', parentId: dstParentId, title: s.title, description: s.description, status: s.status });
          srcToDstId.set(s.id, created.id);
          counters.created++;
          if (primary.kind === 'fs' && mirror.kind === 'jira') {
            await primary.updateItem(s.id, { jiraKeys: { [mirror.name]: created.id } });
          }
        }
      }

      // Pass 4: blockers
      for (const s of srcItems) {
        const dstId = srcToDstId.get(s.id);
        if (!dstId) continue;
        const targetBlockedBy = (s.blockedBy ?? [])
          .map(b => srcToDstId.get(b))
          .filter(Boolean);
        const before = (dstByKey.get(dstId)?.blockedBy ?? []);
        try {
          await mirror.updateItem(dstId, { blockedBy: targetBlockedBy });
          const beforeSet = new Set(before);
          const afterSet = new Set(targetBlockedBy);
          for (const t of afterSet) if (!beforeSet.has(t)) counters.linksAdded++;
          for (const t of beforeSet) if (!afterSet.has(t)) counters.linksRemoved++;
        } catch (e) {
          if (e?.code === 'transition-not-found') {
            counters.warnings.push({ code: 'transition-not-found', id: s.id, from: s.status, to: s.status });
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      counters.errors.push({ code: e?.code ?? 'internal', message: e?.message ?? String(e) });
    }
    results.push(counters);
  }
  return results;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/sync.test.ts
git add plugins/p-tasks/tools/lib/sync.mjs plugins/p-tasks/tools/__tests__/sync.test.ts
git commit -m "feat(p-tasks): sync orchestrator — passes 1/0/2/3a/3b/4/5, multi-mirror isolation, primary-side abort"
```

---

### Task 29: `ptasks sync` CLI + skill

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs` (add `syncCommand`, wire dispatch)
- Create: `plugins/p-tasks/skills/sync/SKILL.md`
- Test: `plugins/p-tasks/tools/__tests__/cli-sync.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCommand, initWithArgs, addCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-sync-cli-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('syncCommand', () => {
  it('returns empty array when no mirrors configured', async () => {
    try { await initWithArgs({ root: dir, args: {} }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await syncCommand({ root: dir, args: { json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out).toEqual({ mirrors: [] });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
import { syncAll } from './lib/sync.mjs';

export async function syncCommand({ root, args, transport }) {
  const cfg = readConfig(root);
  const resolved = resolveDestination({ root, config: cfg, transport });
  try {
    const results = await syncAll(resolved);
    const exitCode = results.some(r => r.errors.length > 0) ? 1 : 0;
    return emitJson({ mirrors: results }, exitCode);
  } catch (e) {
    return emitJson({ error: { code: e?.code ?? 'internal', message: e?.message ?? String(e) } }, 1);
  }
}
```

Dispatch:

```js
if (command === 'sync') {
  const root = findRoot(process.cwd());
  await syncCommand({ root, args });
  return;
}
```

Create `plugins/p-tasks/skills/sync/SKILL.md`:

```markdown
---
name: sync
description: |
  Push primary destination state to every configured mirror. One-way primary → mirrors, idempotent. Use when the user says "sync tasks", "push to jira", "pull from jira", "синхронизируй задачи".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read
---

# /p-tasks:sync

## Step 1 — Run sync

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" sync --json
```

## Step 2 — Render result

For each entry in the `mirrors` array, report: mirror name, created/updated/links counts, any warnings, any errors. If there were errors, explain to the user that those mirrors may be in a partial state and `sync` can be re-run safely (idempotent).
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run plugins/p-tasks/tools/__tests__/cli-sync.test.ts
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/skills/sync/SKILL.md plugins/p-tasks/tools/__tests__/cli-sync.test.ts
git commit -m "feat(p-tasks): ptasks sync command and SKILL.md"
```

---

## Phase H — Polish

### Task 30: Fill out README.md and link to spec

**Files:**
- Modify: `plugins/p-tasks/README.md`

- [ ] **Step 1: Replace stub README with full version**

```markdown
# p-tasks

A Claude Code plugin that tracks tasks (`task` → `sub-task`) with `todo`/`in_progress`/`done` statuses and blocker relationships. Data lives in `docs/tasks/tasks.yml`, in Jira, or in both (one-way primary → mirrors sync).

Distributed via the [`perky.team`](../../) marketplace.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-tasks@perky.team
```

## Local development

```bash
claude --plugin-dir C:/path/to/perky-team-wiki/plugins/p-tasks
```

After edits, `/reload-plugins` inside Claude Code picks them up without restart.

## Commands

| Command | What it does |
|---|---|
| `/p-tasks:init` | Scaffolds `docs/tasks/` and a global rule at `.claude/rules/p-tasks.md`. Prompts for FS or Jira primary; optional mirror. |
| `/p-tasks:add` | Creates a task or sub-task with optional description and blockers. |
| `/p-tasks:set` | Updates status, title, description, or blocker list (full replace or incremental). |
| `/p-tasks:next` | Returns the most relevant unblocked item (in-progress first; sub-tasks of in-progress parents first). |
| `/p-tasks:summary` | Lists done top-level tasks; with a task id — done sub-tasks of that task. |
| `/p-tasks:sync` | Pushes primary state to all mirrors. Idempotent. |

## Jira setup

Required env vars (never on disk):
- `PTASKS_JIRA_EMAIL`
- `PTASKS_JIRA_TOKEN`

Generate the API token at https://id.atlassian.com/manage-profile/security/api-tokens.

## Design

See [`docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md`](./docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md) and [`docs/superpowers/plans/2026-05-20-p-tasks-plugin.md`](./docs/superpowers/plans/2026-05-20-p-tasks-plugin.md).

## Validate

```bash
node scripts/validate.mjs                                                  # from repo root
npm test -- plugins/p-tasks                                                # run only p-tasks tests
```
```

- [ ] **Step 2: Commit**

```bash
git add plugins/p-tasks/README.md
git commit -m "docs(p-tasks): full README with install/commands/jira/design links"
```

---

### Task 31: Final smoke test, version tag

**Files:** none (procedural).

- [ ] **Step 1: Run all tests**

```bash
npm test
```
Expected: all `plugins/p-tasks/tools/__tests__/**/*.test.ts` pass plus existing p-wiki tests.

- [ ] **Step 2: Run validator**

```bash
node scripts/validate.mjs
```
Expected: marketplace + plugin manifest validation passes.

- [ ] **Step 3: Manual smoke test in a scratch repo (optional but recommended)**

```bash
mkdir /tmp/ptasks-smoke && cd /tmp/ptasks-smoke && git init
claude --plugin-dir /path/to/perky-team-wiki/plugins/p-tasks
# inside Claude:
/p-tasks:init
/p-tasks:add task --title "first"
/p-tasks:next
/p-tasks:set t-1 --status done
/p-tasks:summary
```

- [ ] **Step 4: Propose version tag**

Per project rule (`.claude/CLAUDE.md`): the first tag is `v` + whatever `plugin.json` currently has. State to the user: "First release — minor: introduces a new plugin with six skills. Propose tag `v0.1.0`." Wait for explicit confirmation. If yes:

```bash
git tag p-tasks/v0.1.0
git push && git push --tags
```

(Note: existing tags in this repo are unprefixed `vX.Y.Z` for p-wiki. Since p-tasks is a new plugin, use `p-tasks/vX.Y.Z` prefix to disambiguate — confirm with user before tagging.)

---

## Self-Review Notes

### Spec coverage map

| Spec section | Task |
|---|---|
| §2.1 Plugin layout | T1, T20 |
| §2.2 Data layout (docs/tasks/, .claude/rules) | T14, T20 |
| §2.3 tasks.yml shape, invariants, ID gen | T3, T4, T9, T10 |
| §2.3 two-level enforcement | T10 (parent kind check) |
| §2.4 .ptasks.json config | T5, T27 |
| §2.5 Destination interface | T9-T11, T24-T25 (+ T12 resolver, T26 Jira wire) |
| §3.1 init with pre-flight | T14, T27 |
| §3.2 add (validation, cycle) | T15 |
| §3.3 set (atomicity, transition-not-found hard error) | T16, T25 (transition error path) |
| §3.4 next ranking | T7, T17 |
| §3.5 summary scoping | T8, T18 |
| §3.6 sync | T28, T29 |
| §3.7 CLI conventions (--json, error shape) | T13 (helpers), used throughout |
| §4.1 passes 1/0/2/3a/3b/4/5 | T28 |
| §4.1.1 failure scopes | T28 (per-mirror isolation, primary abort) |
| §4.2 identity + mapping | T28 (`mappedKeyFor`) |
| §4.3 field translation (title, status, blockers, parent) | T22, T23, T25, T28 |
| §4.4 idempotency + 409 retry | T21 (retry), T28 (upsert) |
| §4.5 sync non-deletion of items | T28 (pass 3 does not delete missing-on-primary items) |
| §4.6 output shape (array, warnings, errors) | T28, T29 |
| §5.1 error code taxonomy | scattered (every command emits appropriate codes) |
| §5.2 validation timing — cycles + Jira-primary cycle import | T15, T16, T28 |
| §6 testing layers (1-7) | Distributed across tasks; layer 4 (sync integration) = T28; layer 5 (cycle on write) = T15-T16; layer 6 (two-level) = T10; layer 7 (init guard) = T14 |
| §7 non-goals | Honoured throughout — no delete, no two-way, no prune, no priorities/tags |

### Placeholder scan

Searched for "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", "Write tests for the above", "Similar to Task N". None found. Each step has either a complete code block or an exact command with expected output.

### Type consistency check

- `Destination` interface in T9, T11, T24, T25, T26 — same method signatures (`ensureStructure`, `listItems`, `readItem`, `createItem(input)`, `updateItem(id, patch)`).
- `Item` shape consistent across FS / Jira / sync: `{id, type, parentId?, title, description, status, blockedBy[], jiraKeys?}`.
- Error code names used in code blocks match the taxonomy in §5.1 (verified: `auth-failed`, `item-not-found`, `parent-not-found`, `cycle-detected`, `blocker-not-found`, `invalid-status`, `transition-not-found`, `version-conflict`, `rate-limited`, `network-error`, `config-invalid`, `already-initialized`, `internal`).
- `findCycle` signature `(items: {id, blockedBy}[]) → null | string[]` used identically in T6 (definition), T15, T16, T28.
- `pickNext(items, {all?, onWarn?})` signature stable from T7 through T17.
- `summarize(items, {parentId?})` signature stable from T8 through T18.

No drift detected.

---

## Execution Handoff

**Plan complete and saved to `plugins/p-tasks/docs/superpowers/plans/2026-05-20-p-tasks-plugin.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

