# p-tasks superpowers integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend p-tasks with `spec_path`/`plan_path` schema fields, two new skills (`from-plan`, `link-plan`), a SessionStart hook injecting task summary into Claude's context, and updated templates that document the link to superpowers artifacts.

**Architecture:** Adds two opaque optional fields to the task/sub-task schema. Adds two CLI commands (`from-plan`, `link-plan`) implemented as functions in `tools/ptasks.mjs`, following the existing command pattern. Adds a `hooks/hooks.json` with one SessionStart hook calling `node tools/ptasks.mjs summary` via a bash wrapper that graceful-degrades on missing Node or missing `docs/tasks/`. Updates the two markdown templates (rule + CLAUDE.md) to teach Claude about the new commands and the superpowers integration. No PostToolUse hook in this release.

**Tech Stack:** Node.js (ESM, no transpilation), vitest for tests, js-yaml for tasks.yml. Bash for hook script (POSIX, graceful on missing tools). No new runtime dependencies.

---

## Source spec

`docs/superpowers/specs/2026-05-21-marketplace-superpowers-integration-design.md` — section "Plugin: p-tasks" plus principles 2 (self-contained), 3 (read enrichment via SessionStart), 5 (honesty over magic). Re-read this section before starting and after each task as a sanity check.

## File structure — what changes

**Modified:**
- `plugins/p-tasks/tools/lib/schema.mjs` — `validateItem` accepts optional `spec_path`, `plan_path`.
- `plugins/p-tasks/tools/lib/destinations/fs.mjs` — `createItem` and `updateItem` propagate the two new fields.
- `plugins/p-tasks/tools/ptasks.mjs` — adds `fromPlanCommand`, `linkPlanCommand`, registers them in the `KNOWN` array and the main dispatcher.
- `plugins/p-tasks/skills/_shared/templates/CLAUDE.md.tpl` — adds mention of `spec_path`/`plan_path` and the superpowers integration.
- `plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl` — adds new commands and integration line.
- `plugins/p-tasks/.claude-plugin/plugin.json` — bumps `version` from `0.1.0` to `0.2.0` and updates `description`.

**Created:**
- `plugins/p-tasks/skills/from-plan/SKILL.md` — slash command markdown.
- `plugins/p-tasks/skills/link-plan/SKILL.md` — slash command markdown.
- `plugins/p-tasks/hooks/hooks.json` — plugin-provided hook manifest.
- `plugins/p-tasks/hooks/scripts/session-start.sh` — POSIX bash hook script.
- `plugins/p-tasks/tools/lib/parse-plan.mjs` — small parser module isolated for testing.
- `plugins/p-tasks/tools/__tests__/parse-plan.test.ts` — parser unit tests.
- `plugins/p-tasks/tools/__tests__/cli-from-plan.test.ts` — CLI E2E for from-plan.
- `plugins/p-tasks/tools/__tests__/cli-link-plan.test.ts` — CLI E2E for link-plan.
- `plugins/p-tasks/tools/__tests__/cli-summary-hook.test.ts` — verifies summary output shape used by the hook.
- `plugins/p-tasks/tools/__tests__/hook-script.test.ts` — verifies bash hook degrades gracefully when CLI missing.

**Not modified in this plan (deferred):**
- `plugins/p-tasks/tools/lib/destinations/jira.mjs` — Jira destination support for `spec_path`/`plan_path` deferred. The fields propagate through the FS destination and pass-through in summary output; Jira sync of the new fields is a follow-up.

---

### Task 1: Schema accepts optional spec_path and plan_path

**Files:**
- Modify: `plugins/p-tasks/tools/lib/schema.mjs`
- Test: `plugins/p-tasks/tools/__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `plugins/p-tasks/tools/__tests__/schema.test.ts` and append inside `describe('validateItem', () => { … })`:

```ts
  it('accepts an optional spec_path', () => {
    expect(validateItem({ ...valid, spec_path: 'docs/superpowers/specs/foo.md' })).toEqual({ ok: true });
  });
  it('accepts an optional plan_path', () => {
    expect(validateItem({ ...valid, plan_path: 'docs/superpowers/plans/foo.md' })).toEqual({ ok: true });
  });
  it('rejects non-string spec_path', () => {
    expect(validateItem({ ...valid, spec_path: 42 }).ok).toBe(false);
  });
  it('rejects non-string plan_path', () => {
    expect(validateItem({ ...valid, plan_path: ['x'] }).ok).toBe(false);
  });
  it('treats absent spec_path/plan_path as fine', () => {
    expect(validateItem(valid)).toEqual({ ok: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- plugins/p-tasks/tools/__tests__/schema.test.ts`
Expected: 4 of the 5 new tests pass (the "accepts" cases pass because the validator doesn't currently know about the field, and the "treats absent" case is the existing behavior). The "rejects non-string" cases FAIL — current code does not validate type of unknown fields.

- [ ] **Step 3: Update schema validator**

Edit `plugins/p-tasks/tools/lib/schema.mjs`. Inside `validateItem`, after the existing `blockedBy` check and before the `parsed = parseId(item.id)` block, insert:

```js
  if ('spec_path' in item && typeof item.spec_path !== 'string') {
    return { ok: false, error: 'spec_path must be a string when present' };
  }
  if ('plan_path' in item && typeof item.plan_path !== 'string') {
    return { ok: false, error: 'plan_path must be a string when present' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- plugins/p-tasks/tools/__tests__/schema.test.ts`
Expected: all 5 new tests PASS, all existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/tools/lib/schema.mjs plugins/p-tasks/tools/__tests__/schema.test.ts
git commit -m "feat(p-tasks): schema accepts optional spec_path and plan_path"
```

---

### Task 2: FS destination persists spec_path and plan_path

**Files:**
- Modify: `plugins/p-tasks/tools/lib/destinations/fs.mjs`
- Test: `plugins/p-tasks/tools/__tests__/fs-create.test.ts`
- Test: `plugins/p-tasks/tools/__tests__/fs-update.test.ts`

- [ ] **Step 1: Write the failing test for create**

Open `plugins/p-tasks/tools/__tests__/fs-create.test.ts` and append a new `it` block at the end of the outer describe:

```ts
  it('persists spec_path and plan_path on createItem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-paths-'));
    try {
      const dest = createFsDestination({ root: dir });
      await dest.ensureStructure();
      const created = await dest.createItem({
        type: 'task',
        title: 'X',
        description: '',
        status: 'todo',
        blockedBy: [],
        spec_path: 'docs/superpowers/specs/x.md',
        plan_path: 'docs/superpowers/plans/x.md',
      });
      expect(created.spec_path).toBe('docs/superpowers/specs/x.md');
      expect(created.plan_path).toBe('docs/superpowers/plans/x.md');
      const items = await dest.listItems();
      expect(items[0].spec_path).toBe('docs/superpowers/specs/x.md');
      expect(items[0].plan_path).toBe('docs/superpowers/plans/x.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

If imports `mkdtempSync, rmSync, tmpdir, join` are not already present at the top of the file, add them:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- plugins/p-tasks/tools/__tests__/fs-create.test.ts`
Expected: new test FAILs — `created.spec_path` is `undefined` (the current `createItem` strips unknown fields).

- [ ] **Step 3: Update createItem to propagate optional fields**

Edit `plugins/p-tasks/tools/lib/destinations/fs.mjs`. In `createItem`, replace the `const base = { … }` block with:

```js
      const base = {
        id,
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'todo',
        blockedBy: input.blockedBy ?? [],
      };
      if (typeof input.spec_path === 'string') base.spec_path = input.spec_path;
      if (typeof input.plan_path === 'string') base.plan_path = input.plan_path;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- plugins/p-tasks/tools/__tests__/fs-create.test.ts`
Expected: PASS for the new test; existing fs-create tests still PASS.

- [ ] **Step 5: Write the failing test for update**

Open `plugins/p-tasks/tools/__tests__/fs-update.test.ts` and append at the end of the outer describe:

```ts
  it('updates spec_path and plan_path via updateItem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-update-paths-'));
    try {
      const dest = createFsDestination({ root: dir });
      await dest.ensureStructure();
      await dest.createItem({ type: 'task', title: 'X', description: '', status: 'todo', blockedBy: [] });
      const updated = await dest.updateItem('t-1', {
        spec_path: 'docs/superpowers/specs/y.md',
        plan_path: 'docs/superpowers/plans/y.md',
      });
      expect(updated.spec_path).toBe('docs/superpowers/specs/y.md');
      expect(updated.plan_path).toBe('docs/superpowers/plans/y.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

Add the same `mkdtempSync, rmSync, tmpdir, join` imports if missing.

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- plugins/p-tasks/tools/__tests__/fs-update.test.ts`
Expected: new test FAILs — `updateItem` does not propagate the new fields.

- [ ] **Step 7: Update updateItem to propagate optional fields**

In `plugins/p-tasks/tools/lib/destinations/fs.mjs`, inside `updateItem` after the existing `if ('blockedBy' in patch) … ` line and before `if ('jiraKeys' in patch) …`, insert:

```js
      if ('spec_path' in patch) found.spec_path = patch.spec_path;
      if ('plan_path' in patch) found.plan_path = patch.plan_path;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- plugins/p-tasks/tools/__tests__/fs-update.test.ts plugins/p-tasks/tools/__tests__/fs-create.test.ts`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/p-tasks/tools/lib/destinations/fs.mjs plugins/p-tasks/tools/__tests__/fs-create.test.ts plugins/p-tasks/tools/__tests__/fs-update.test.ts
git commit -m "feat(p-tasks): FS destination persists spec_path and plan_path"
```

---

### Task 3: parse-plan module — lenient plan header parser

**Files:**
- Create: `plugins/p-tasks/tools/lib/parse-plan.mjs`
- Create: `plugins/p-tasks/tools/__tests__/parse-plan.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-tasks/tools/__tests__/parse-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parsePlanHeader } from '../lib/parse-plan.mjs';

describe('parsePlanHeader', () => {
  it('extracts feature name from a standard superpowers plan header', () => {
    const md = '# Auth Implementation Plan\n\n**Goal:** add login\n';
    expect(parsePlanHeader(md).title).toBe('Auth');
  });

  it('extracts feature name when header has extra whitespace', () => {
    const md = '#   Multi Word Feature   Implementation Plan  \n';
    expect(parsePlanHeader(md).title).toBe('Multi Word Feature');
  });

  it('returns null title when header does not match the template', () => {
    const md = '# Some Random Doc\n\nNot a plan.\n';
    expect(parsePlanHeader(md).title).toBeNull();
  });

  it('returns null title for empty input', () => {
    expect(parsePlanHeader('').title).toBeNull();
  });

  it('extracts a Spec: reference if present in the header block', () => {
    const md = '# Auth Implementation Plan\n\n**Spec:** docs/superpowers/specs/2026-05-20-auth-design.md\n\n**Goal:** …\n';
    expect(parsePlanHeader(md).specPath).toBe('docs/superpowers/specs/2026-05-20-auth-design.md');
  });

  it('returns null specPath when no Spec: reference', () => {
    const md = '# Auth Implementation Plan\n\n**Goal:** …\n';
    expect(parsePlanHeader(md).specPath).toBeNull();
  });

  it('only looks at the first 30 lines (does not match Spec: deep in the body)', () => {
    const body = Array(50).fill('filler').join('\n');
    const md = `# X Implementation Plan\n${body}\n**Spec:** docs/spec.md\n`;
    expect(parsePlanHeader(md).specPath).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- plugins/p-tasks/tools/__tests__/parse-plan.test.ts`
Expected: all 7 tests FAIL with module-not-found error.

- [ ] **Step 3: Implement parse-plan.mjs**

Create `plugins/p-tasks/tools/lib/parse-plan.mjs`:

```js
const HEADER_RE = /^#\s+(.+?)\s+Implementation Plan\s*$/;
const SPEC_RE = /\*\*Spec:\*\*\s*(\S+)/;
const HEADER_SCAN_LINES = 30;

export function parsePlanHeader(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { title: null, specPath: null };
  }
  const lines = markdown.split(/\r?\n/, HEADER_SCAN_LINES);
  let title = null;
  let specPath = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (title === null) {
      const m = HEADER_RE.exec(line);
      if (m) {
        title = m[1].replace(/\s+/g, ' ').trim();
        continue;
      }
    }
    if (specPath === null) {
      const s = SPEC_RE.exec(line);
      if (s) {
        specPath = s[1];
      }
    }
  }
  return { title, specPath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- plugins/p-tasks/tools/__tests__/parse-plan.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/tools/lib/parse-plan.mjs plugins/p-tasks/tools/__tests__/parse-plan.test.ts
git commit -m "feat(p-tasks): lenient plan-header parser"
```

---

### Task 4: from-plan CLI command

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs`
- Create: `plugins/p-tasks/tools/__tests__/cli-from-plan.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-tasks/tools/__tests__/cli-from-plan.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPlanCommand, initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-from-plan-'));
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

function writePlan(relPath: string, content: string) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return relPath;
}

describe('fromPlanCommand', () => {
  it('creates a top-level task with plan_path and title from header', async () => {
    const rel = writePlan('docs/superpowers/plans/2026-05-21-auth.md',
      '# Auth Implementation Plan\n\n**Spec:** docs/superpowers/specs/2026-05-20-auth-design.md\n');
    try { await fromPlanCommand({ root: dir, args: { _: [rel] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.id).toBe('t-1');
    expect(out.title).toBe('Auth');
    expect(out.plan_path).toBe(rel);
    expect(out.spec_path).toBe('docs/superpowers/specs/2026-05-20-auth-design.md');
  });

  it('falls back to filename slug when header is non-standard', async () => {
    const rel = writePlan('docs/superpowers/plans/2026-05-21-payments.md',
      '# Some Random Doc\n\nNot a plan.\n');
    try { await fromPlanCommand({ root: dir, args: { _: [rel] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.plan_path).toBe(rel);
    expect(out.title).toBe('2026-05-21-payments');
    expect(out.spec_path).toBeUndefined();
  });

  it('errors when path is missing', async () => {
    try { await fromPlanCommand({ root: dir, args: { _: [] } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.error.code).toBe('path-required');
  });

  it('errors when file does not exist', async () => {
    try { await fromPlanCommand({ root: dir, args: { _: ['docs/missing.md'] } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.error.code).toBe('file-not-found');
  });

  it('accepts an absolute path and stores the path verbatim', async () => {
    const rel = writePlan('docs/superpowers/plans/abs.md', '# Abs Implementation Plan\n');
    const abs = join(dir, rel);
    try { await fromPlanCommand({ root: dir, args: { _: [abs] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.plan_path).toBe(abs);
    expect(out.title).toBe('Abs');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-from-plan.test.ts`
Expected: all 5 tests FAIL with import error for `fromPlanCommand`.

- [ ] **Step 3: Implement fromPlanCommand**

Edit `plugins/p-tasks/tools/ptasks.mjs`. After the `addCommand` function and before `setCommand`, insert:

```js
export async function fromPlanCommand({ root, args }) {
  const path = args._[0];
  if (!path) return emitJson({ error: { code: 'path-required', message: 'usage: ptasks from-plan <path-to-plan.md>' } }, 1);

  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  if (!fs.existsSync(path)) {
    return emitJson({ error: { code: 'file-not-found', message: `plan file not found: ${path}` } }, 1);
  }
  const content = fs.readFileSync(path, 'utf-8');
  const { parsePlanHeader } = await import('./lib/parse-plan.mjs');
  const parsed = parsePlanHeader(content);

  let title = parsed.title;
  if (title === null) {
    const base = nodePath.basename(path).replace(/\.md$/, '');
    title = base;
  }

  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();

  let created;
  try {
    const input = {
      type: 'task',
      title,
      description: '',
      status: 'todo',
      blockedBy: [],
      plan_path: path,
    };
    if (parsed.specPath) input.spec_path = parsed.specPath;
    created = await primary.createItem(input);
  } catch (e) {
    return emitJson({ error: { code: e?.code ?? 'internal', message: e?.message ?? String(e) } }, 1);
  }
  return emitJson(created, 0);
}
```

- [ ] **Step 4: Register the command in the dispatcher**

In `plugins/p-tasks/tools/ptasks.mjs`, find the line `const KNOWN = ['init', 'add', 'set', 'next', 'summary', 'sync'];` and replace with:

```js
    const KNOWN = ['init', 'add', 'set', 'next', 'summary', 'sync', 'from-plan', 'link-plan'];
```

Then, after the existing `if (command === 'sync') { … return; }` block, before the `die(...)` final line, insert:

```js
    if (command === 'from-plan') {
      const root = findRoot(process.cwd());
      await fromPlanCommand({ root, args });
      return;
    }
```

(The `link-plan` dispatcher will be added in Task 5.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-from-plan.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 6: Run the full suite to check nothing else broke**

Run: `npm test -- plugins/p-tasks`
Expected: all p-tasks tests PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-from-plan.test.ts
git commit -m "feat(p-tasks): from-plan command creates task with plan_path"
```

---

### Task 5: link-plan CLI command

**Files:**
- Modify: `plugins/p-tasks/tools/ptasks.mjs`
- Create: `plugins/p-tasks/tools/__tests__/cli-link-plan.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/p-tasks/tools/__tests__/cli-link-plan.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommand, linkPlanCommand, initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-link-plan-'));
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

describe('linkPlanCommand', () => {
  it('sets plan_path on an existing task', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X' } }); } catch {}
    const planRel = 'docs/superpowers/plans/x.md';
    mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
    writeFileSync(join(dir, planRel), '# X Implementation Plan\n', 'utf-8');
    stdoutSpy.mockClear();
    try { await linkPlanCommand({ root: dir, args: { _: ['t-1', planRel] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.id).toBe('t-1');
    expect(out.plan_path).toBe(planRel);
  });

  it('errors when task id is unknown', async () => {
    const planRel = 'docs/superpowers/plans/x.md';
    mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
    writeFileSync(join(dir, planRel), '# X Implementation Plan\n', 'utf-8');
    try { await linkPlanCommand({ root: dir, args: { _: ['t-99', planRel] } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.error.code).toBe('item-not-found');
  });

  it('errors when plan file does not exist', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X' } }); } catch {}
    stdoutSpy.mockClear();
    try { await linkPlanCommand({ root: dir, args: { _: ['t-1', 'docs/missing.md'] } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.error.code).toBe('file-not-found');
  });

  it('errors when arguments are missing', async () => {
    try { await linkPlanCommand({ root: dir, args: { _: [] } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.error.code).toBe('args-required');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-link-plan.test.ts`
Expected: all 4 tests FAIL with import error for `linkPlanCommand`.

- [ ] **Step 3: Implement linkPlanCommand**

Edit `plugins/p-tasks/tools/ptasks.mjs`. After the `fromPlanCommand` function and before `setCommand`, insert:

```js
export async function linkPlanCommand({ root, args }) {
  const id = args._[0];
  const path = args._[1];
  if (!id || !path) {
    return emitJson({ error: { code: 'args-required', message: 'usage: ptasks link-plan <task-id> <path-to-plan.md>' } }, 1);
  }

  const fs = await import('node:fs');
  if (!fs.existsSync(path)) {
    return emitJson({ error: { code: 'file-not-found', message: `plan file not found: ${path}` } }, 1);
  }

  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  if (!items.find(i => i.id === id)) {
    return emitJson({ error: { code: 'item-not-found', message: `id ${id} not found` } }, 1);
  }

  let updated;
  try {
    updated = await primary.updateItem(id, { plan_path: path });
  } catch (e) {
    return emitJson({ error: { code: e?.code ?? 'internal', message: e?.message ?? String(e) } }, 1);
  }
  return emitJson(updated, 0);
}
```

- [ ] **Step 4: Register the command in the dispatcher**

In `plugins/p-tasks/tools/ptasks.mjs`, after the `from-plan` block inserted in Task 4, append:

```js
    if (command === 'link-plan') {
      const root = findRoot(process.cwd());
      await linkPlanCommand({ root, args });
      return;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-link-plan.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test -- plugins/p-tasks`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-tasks/tools/ptasks.mjs plugins/p-tasks/tools/__tests__/cli-link-plan.test.ts
git commit -m "feat(p-tasks): link-plan command updates plan_path on existing task"
```

---

### Task 6: from-plan skill

**Files:**
- Create: `plugins/p-tasks/skills/from-plan/SKILL.md`

- [ ] **Step 1: Create the skill markdown**

Create `plugins/p-tasks/skills/from-plan/SKILL.md` with this exact content:

```markdown
---
name: from-plan
description: |
  Create a top-level p-tasks task from a superpowers plan file. Parses the plan header to extract the feature title and an optional Spec: reference. Use when the user says "track this plan", "create task from plan", or after `superpowers:writing-plans` writes a new plan.
argument-hint: <path-to-plan.md>
allowed-tools: Bash(node:*) Read
---

# /p-tasks:from-plan

You are creating a task from a superpowers plan file.

`$ARGUMENTS` is a path to a plan markdown file. If missing, ask the user for the path.

## Step 1 — Invoke the CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" from-plan "$ARGUMENTS"
```

## Step 2 — Render outcome

On exit 0: parse the printed JSON. Tell the user:
- The new task id (e.g. `t-3`).
- The title that was extracted (or the filename-slug fallback).
- Whether a `spec_path` was also captured.

On exit 1: read the JSON `error.code` and explain:
- `path-required`: ask the user for the plan file path.
- `file-not-found`: the file does not exist at the given path.
- `internal` or other: forward the message verbatim.

## When to use

This skill is most useful immediately after `superpowers:writing-plans` produces a new plan in `docs/superpowers/plans/`. If a global rule (e.g. from p-flow) instructs Claude to call this automatically, follow the rule.

## Header parsing is lenient

The CLI extracts the feature name from a header of the form `# <Name> Implementation Plan`. If the header does not match this template, the CLI falls back to the filename (without `.md`) as the title. Either way, the task is created and `plan_path` is set; only the title quality degrades. The skill does not need to retry on parse "failures".
```

- [ ] **Step 2: Commit**

```bash
git add plugins/p-tasks/skills/from-plan/SKILL.md
git commit -m "feat(p-tasks): from-plan slash command skill"
```

---

### Task 7: link-plan skill

**Files:**
- Create: `plugins/p-tasks/skills/link-plan/SKILL.md`

- [ ] **Step 1: Create the skill markdown**

Create `plugins/p-tasks/skills/link-plan/SKILL.md` with this exact content:

```markdown
---
name: link-plan
description: |
  Attach a plan_path to an existing p-tasks task. Use when the user says "link plan to task t-N", or when a plan was written for an already-tracked task (e.g. a task created earlier without a plan).
argument-hint: <task-id> <path-to-plan.md>
allowed-tools: Bash(node:*) Read
---

# /p-tasks:link-plan

You are attaching a plan file to an existing task.

`$ARGUMENTS` is `<task-id> <path-to-plan.md>`. If either is missing, ask the user.

## Step 1 — Invoke the CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" link-plan "<task-id>" "<path>"
```

## Step 2 — Render outcome

On exit 0: confirm the task id and the new `plan_path` value.

On exit 1: read the JSON `error.code` and explain:
- `args-required`: ask the user for both task id and path.
- `item-not-found`: the task id does not exist. Suggest `/p-tasks:summary` to list known ids.
- `file-not-found`: the plan file does not exist at the given path.
- `internal` or other: forward the message verbatim.

## When to use

Prefer `/p-tasks:from-plan` when creating a fresh task from a fresh plan — it does both in one step. Use `/p-tasks:link-plan` only when the task already exists (for example, it was created from a spec earlier and a plan was written later).
```

- [ ] **Step 2: Commit**

```bash
git add plugins/p-tasks/skills/link-plan/SKILL.md
git commit -m "feat(p-tasks): link-plan slash command skill"
```

---

### Task 8: SessionStart hook script and manifest

**Files:**
- Create: `plugins/p-tasks/hooks/hooks.json`
- Create: `plugins/p-tasks/hooks/scripts/session-start.sh`
- Create: `plugins/p-tasks/tools/__tests__/cli-summary-hook.test.ts`
- Create: `plugins/p-tasks/tools/__tests__/hook-script.test.ts`

- [ ] **Step 1: Write the failing test for summary output shape**

Create `plugins/p-tasks/tools/__tests__/cli-summary-hook.test.ts`. This test asserts that `summary --format=json` returns a structure usable by the hook script:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommand, summaryCommand, setCommand, initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-summary-hook-'));
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

describe('summary output for hook consumption', () => {
  it('returns an empty items array when no tasks exist', async () => {
    try { await summaryCommand({ root: dir, args: { _: [] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out).toEqual({ items: [] });
  });

  it('returns active tasks (todo + in_progress) with id, title, status', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'Auth' } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'Payments' } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress' } }); } catch {}
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: [] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(Array.isArray(out.items)).toBe(true);
    const titles = out.items.map((i: any) => i.title);
    expect(titles).toContain('Auth');
    expect(titles).toContain('Payments');
    for (const item of out.items) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.status).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify the contract is met**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-summary-hook.test.ts`
Expected: PASS. The existing `summary` command already returns this shape — this test pins the contract so future changes that break the hook are caught.

If a test FAILS, do **not** change the test; instead inspect the actual `summary` output and adjust `summaryCommand` only if there is a genuine regression. If the existing behavior differs, update the hook script in Step 4 below to match what `summary` actually emits.

- [ ] **Step 3: Create the hook manifest**

Create `plugins/p-tasks/hooks/hooks.json` with this exact content:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-start.sh\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Create the hook script**

Create `plugins/p-tasks/hooks/scripts/session-start.sh` with this exact content (POSIX bash, no bashisms beyond what `bash` supports universally):

```bash
#!/usr/bin/env bash
# p-tasks SessionStart hook.
# Injects an active-tasks summary into Claude's context as additionalContext.
# Must never block the session: silent exit 0 on any unmet precondition.

set -u

# Resolve repo root; fall back to PWD if not a git repo.
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Bail silently if p-tasks not initialised in this repo.
if [ ! -f "${root}/docs/tasks/.ptasks.json" ]; then
  exit 0
fi

# Bail silently if Node is missing.
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

# Bail silently if the plugin CLI is unreachable.
cli="${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs"
if [ ! -f "${cli}" ]; then
  exit 0
fi

# Invoke summary. If it fails, exit 0 (advisory only).
raw="$(cd "${root}" && node "${cli}" summary 2>/dev/null)" || exit 0

# Empty output -> nothing to inject.
if [ -z "${raw}" ]; then
  exit 0
fi

# Compose additionalContext payload.
# We emit a small JSON via printf because jq may not be available.
# We include a HTML-comment marker so duplicate injections are detectable.
context_marker="<!-- p-tasks:session-context -->"
context_body="${context_marker}\\n## Active p-tasks\\n\\nRaw summary (JSON): ${raw}\\n\\nUse \\\`/p-tasks:next\\\` for the next unblocked item."

# Escape the body for embedding in JSON.
# Inline minimal JSON escape: backslashes, double quotes, newlines.
esc=$(printf '%s' "${context_body}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null) || esc="${context_body}"

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "${esc}"
exit 0
```

Note: this script uses `python3` for JSON escaping if available, falling back to the raw string. Both ASCII-only repos and most dev machines have python3. If a target lacks both python3 and any other escaper, the fallback emits potentially-unescaped output — the hook still exits 0 and Claude tolerates malformed additionalContext as advisory.

- [ ] **Step 5: Make the script executable (Unix; Windows-Git tolerates it)**

```bash
chmod +x plugins/p-tasks/hooks/scripts/session-start.sh
```

- [ ] **Step 6: Write a test for the hook script's graceful degradation**

Create `plugins/p-tasks/tools/__tests__/hook-script.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'plugins/p-tasks/hooks/scripts/session-start.sh');

function run(env: Record<string, string>, cwd: string): { stdout: string; status: number } {
  try {
    const stdout = execSync(`bash "${SCRIPT}"`, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? '', status: e.status ?? 1 };
  }
}

describe('SessionStart hook script', () => {
  it('exits 0 silently when p-tasks is not initialised in the repo', () => {
    if (platform() === 'win32' && !existsSync('/usr/bin/bash') && !existsSync('C:/Program Files/Git/bin/bash.exe')) {
      return; // skip on Windows hosts without bash
    }
    const dir = mkdtempSync(join(tmpdir(), 'ptasks-hook-noinit-'));
    try {
      const result = run({ CLAUDE_PLUGIN_ROOT: join(process.cwd(), 'plugins/p-tasks') }, dir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 silently when CLAUDE_PLUGIN_ROOT points to a non-existent CLI', () => {
    if (platform() === 'win32' && !existsSync('/usr/bin/bash') && !existsSync('C:/Program Files/Git/bin/bash.exe')) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'ptasks-hook-noroot-'));
    try {
      mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), '{}', 'utf-8');
      const result = run({ CLAUDE_PLUGIN_ROOT: join(dir, 'nonexistent-plugin-root') }, dir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- plugins/p-tasks/tools/__tests__/hook-script.test.ts plugins/p-tasks/tools/__tests__/cli-summary-hook.test.ts`
Expected: all PASS. (On Windows without bash on PATH, the hook-script test silently skips both cases — both have an early return guard.)

- [ ] **Step 8: Commit**

```bash
git add plugins/p-tasks/hooks/hooks.json plugins/p-tasks/hooks/scripts/session-start.sh plugins/p-tasks/tools/__tests__/cli-summary-hook.test.ts plugins/p-tasks/tools/__tests__/hook-script.test.ts
git commit -m "feat(p-tasks): SessionStart hook injects active-tasks summary"
```

---

### Task 9: Update CLAUDE.md and rule templates

**Files:**
- Modify: `plugins/p-tasks/skills/_shared/templates/CLAUDE.md.tpl`
- Modify: `plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl`

- [ ] **Step 1: Update CLAUDE.md.tpl**

Replace the entire contents of `plugins/p-tasks/skills/_shared/templates/CLAUDE.md.tpl` with:

```markdown
# p-tasks data store

Tasks live in `tasks.yml` at this directory. Two-level hierarchy:
- top-level: `task` (`id: t-N`)
- nested under `subTasks`: `sub-task` (`id: st-N`)

Statuses: `todo` | `in_progress` | `done`. Use `/p-tasks:` commands to mutate.
Do not hand-edit unless you know what you are doing — id reuse is forbidden, and the canonical mutators (`/p-tasks:add`, `/p-tasks:set`) enforce structural invariants the file format does not.

## Optional path fields

Each task or sub-task may carry two opaque path fields:

- `spec_path` — relative path to a superpowers spec (typically under `docs/superpowers/specs/`).
- `plan_path` — relative path to a superpowers plan (typically under `docs/superpowers/plans/`).

These fields are populated automatically by `/p-tasks:from-plan` and `/p-tasks:link-plan`. They link a task to the artifacts that describe it, so the implementation agent can read the full plan when picking up the task.

## Granularity

Each top-level task corresponds to **one feature** with one plan. Sub-tasks decompose that feature into sub-features — not into the steps inside the plan. Steps belong in `plan_path` and are followed by `superpowers:executing-plans` / `subagent-driven-development`.
```

- [ ] **Step 2: Update p-tasks.rule.md.tpl**

Replace the entire contents of `plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl` with:

```markdown
# p-tasks

A task tracker plugin is installed in this repo at `docs/tasks/tasks.yml`.

Slash commands:
- `/p-tasks:add` — create a task or sub-task
- `/p-tasks:set <id>` — change status, title, description, or blockers
- `/p-tasks:next` — return the next unblocked item
- `/p-tasks:summary [<id>]` — list done items (and current todo/in_progress via JSON output)
- `/p-tasks:sync` — push primary state to all mirrors
- `/p-tasks:from-plan <path-to-plan.md>` — create a top-level task from a superpowers plan (sets `plan_path`, attempts to set `spec_path`)
- `/p-tasks:link-plan <task-id> <path-to-plan.md>` — attach a `plan_path` to an existing task

`/p-tasks:init` is one-shot — do not re-run it.

## Integration with superpowers

A task in p-tasks represents **one feature**, not one step of a plan. The full step-by-step plan lives in the file referenced by `plan_path` (typically under `docs/superpowers/plans/`); `superpowers:executing-plans` and `superpowers:subagent-driven-development` work directly from that file. p-tasks tracks _which_ feature is in progress, blocked, or done.

When `superpowers:writing-plans` writes a new plan to `docs/superpowers/plans/`, call `/p-tasks:from-plan <path>` to register it as a tracked task. When starting work, set the task to `in_progress`; when the plan completes, set it to `done`. These transitions are best-effort, not automatic.

## SessionStart hook

This plugin ships a SessionStart hook that injects a short summary of active tasks into Claude's context once per session. The summary lives in `hookSpecificOutput.additionalContext` and is marked with the HTML comment `<!-- p-tasks:session-context -->` so duplicates are detectable. The hook silently exits with code 0 (no injection) if p-tasks is not initialised in the repo, if Node is missing, or if the CLI is unavailable.
```

- [ ] **Step 3: Verify init still produces correct output**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-init.test.ts`
Expected: existing init tests PASS (templates are read verbatim into the project).

- [ ] **Step 4: Commit**

```bash
git add plugins/p-tasks/skills/_shared/templates/CLAUDE.md.tpl plugins/p-tasks/skills/_shared/templates/p-tasks.rule.md.tpl
git commit -m "docs(p-tasks): templates document spec_path/plan_path and superpowers link"
```

---

### Task 10: Bump plugin manifest version and description

**Files:**
- Modify: `plugins/p-tasks/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Update plugin.json**

Replace the contents of `plugins/p-tasks/.claude-plugin/plugin.json` with:

```json
{
  "name": "p-tasks",
  "version": "0.2.0",
  "description": "Two-level task tracker (task → sub-task) with FS and Jira destinations, one-way primary→mirrors sync. Skills: init, add, set, next, summary, sync, from-plan, link-plan. SessionStart hook injects active-tasks summary.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 2: Update marketplace.json description for p-tasks**

Edit `.claude-plugin/marketplace.json`. Replace the existing p-tasks entry with:

```json
    {
      "name": "p-tasks",
      "source": "./plugins/p-tasks",
      "description": "Task tracker (task → sub-task) with FS and Jira destinations, one-way sync. Skills: init, add, set, next, summary, sync, from-plan, link-plan. SessionStart hook surfaces active tasks."
    }
```

(Leave the other plugin entries unchanged.)

- [ ] **Step 3: Validate plugin metadata**

Run: `node scripts/validate.mjs`
Expected: validation PASSES.

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: all tests across the marketplace PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-tasks/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(p-tasks): bump to 0.2.0 with new skills and SessionStart hook"
```

---

### Task 11: README update

**Files:**
- Modify: `plugins/p-tasks/README.md`

- [ ] **Step 1: Update README to document new commands and hook**

In `plugins/p-tasks/README.md`, find the table starting with `| Command | What it does |` and replace it with:

```markdown
| Command | What it does |
|---|---|
| `/p-tasks:init` | Scaffolds `docs/tasks/` and a global rule at `.claude/rules/p-tasks.md`. Prompts for FS or Jira primary; optional mirror. |
| `/p-tasks:add` | Creates a task or sub-task with optional description and blockers. |
| `/p-tasks:set` | Updates status, title, description, or blocker list (full replace or incremental). |
| `/p-tasks:next` | Returns the most relevant unblocked item (in-progress first; sub-tasks of in-progress parents first). |
| `/p-tasks:summary` | Lists done top-level tasks; with a task id — done sub-tasks of that task. |
| `/p-tasks:sync` | Pushes primary state to all mirrors. Idempotent. |
| `/p-tasks:from-plan <path>` | Creates a top-level task from a superpowers plan file. Sets `plan_path` and attempts to set `spec_path` from the plan header. |
| `/p-tasks:link-plan <id> <path>` | Attaches a `plan_path` to an existing task. |
```

Then, immediately after the table, insert a new section before the existing `## Jira setup` heading:

```markdown
## Superpowers integration

When `superpowers:writing-plans` writes a plan to `docs/superpowers/plans/`, run `/p-tasks:from-plan <path>` to register it as a tracked task. The task carries `plan_path` (and optionally `spec_path` if the plan header references one). A SessionStart hook surfaces active tasks at the start of every session so the controller agent knows what is in flight without reading the YAML.

Tasks correspond to **features**, not to individual steps of a plan. Step-level work stays in the plan file and is executed by `superpowers:executing-plans` or `superpowers:subagent-driven-development`.

```

- [ ] **Step 2: Commit**

```bash
git add plugins/p-tasks/README.md
git commit -m "docs(p-tasks): README documents from-plan, link-plan, SessionStart hook"
```

---

### Task 12: End-to-end smoke test

**Files:**
- Create: `plugins/p-tasks/tools/__tests__/cli-superpowers-integration.test.ts`

- [ ] **Step 1: Write a smoke test that exercises the whole flow**

Create `plugins/p-tasks/tools/__tests__/cli-superpowers-integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPlanCommand, linkPlanCommand, summaryCommand, setCommand, initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-sp-integration-'));
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

describe('p-tasks ↔ superpowers integration smoke', () => {
  it('from-plan → set in_progress → summary → set done', async () => {
    mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
    const plan = join(dir, 'docs/superpowers/plans/2026-05-21-auth.md');
    writeFileSync(plan, '# Auth Implementation Plan\n\n**Spec:** docs/superpowers/specs/2026-05-20-auth-design.md\n', 'utf-8');

    // 1. from-plan creates a task with plan_path and spec_path
    try { await fromPlanCommand({ root: dir, args: { _: [plan] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    let out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.id).toBe('t-1');
    expect(out.title).toBe('Auth');
    expect(out.plan_path).toBe(plan);
    expect(out.spec_path).toBe('docs/superpowers/specs/2026-05-20-auth-design.md');
    stdoutSpy.mockClear();

    // 2. Mark in_progress
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress' } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    stdoutSpy.mockClear();

    // 3. Summary reflects the active task
    try { await summaryCommand({ root: dir, args: { _: [] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    const titles = out.items.map((i: any) => i.title);
    expect(titles).toContain('Auth');
    stdoutSpy.mockClear();

    // 4. Mark done
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'done' } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
  });

  it('add-then-link-plan: existing task picks up plan_path retroactively', async () => {
    const { addCommand } = await import('../ptasks.mjs');
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'Payments' } }); }
    catch {}
    stdoutSpy.mockClear();

    mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
    const plan = join(dir, 'docs/superpowers/plans/2026-05-22-payments.md');
    writeFileSync(plan, '# Payments Implementation Plan\n', 'utf-8');

    try { await linkPlanCommand({ root: dir, args: { _: ['t-1', plan] } }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls.at(-1)![0]);
    expect(out.id).toBe('t-1');
    expect(out.plan_path).toBe(plan);
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run: `npm test -- plugins/p-tasks/tools/__tests__/cli-superpowers-integration.test.ts`
Expected: both scenarios PASS.

- [ ] **Step 3: Run the entire repo test suite as a final regression check**

Run: `npm test`
Expected: every test in the marketplace PASSES.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-tasks/tools/__tests__/cli-superpowers-integration.test.ts
git commit -m "test(p-tasks): smoke test for end-to-end superpowers integration"
```

---

## Self-review checklist

**Spec coverage:**
- ✅ `spec_path`/`plan_path` schema fields — Task 1 (schema) + Task 2 (FS persistence).
- ✅ `/p-tasks:from-plan` skill + CLI — Tasks 3, 4, 6.
- ✅ `/p-tasks:link-plan` skill + CLI — Tasks 5, 7.
- ✅ SessionStart hook with graceful degradation — Task 8.
- ✅ Updated CLAUDE.md and rule templates — Task 9.
- ✅ Plugin version bump and marketplace description — Task 10.
- ✅ README — Task 11.
- ✅ End-to-end smoke — Task 12.
- ✅ No PostToolUse hook in default config (verified by absence — only SessionStart in `hooks.json`).
- ✅ CLI graceful-degradation pattern — Task 8 step 4 hook script.
- ✅ Lenient header parsing — Task 3 parser + Task 4 fallback to filename.
- ✅ `hookSpecificOutput.additionalContext` format — Task 8 step 4 hook script output.

**Type consistency:**
- Schema field names `spec_path` and `plan_path` (snake_case) used uniformly across schema.mjs, fs.mjs, parse-plan.mjs (`specPath` is parser internal, mapped to `spec_path` at the CLI boundary in Task 4 step 3), ptasks.mjs CLI functions, skill markdown, templates.
- Function names `fromPlanCommand` / `linkPlanCommand` consistent across ptasks.mjs definitions, dispatcher registrations, test imports.
- Error codes `path-required` / `file-not-found` / `args-required` / `item-not-found` used in identical strings in CLI returns and in test assertions.

**Placeholder scan:** none of the listed anti-patterns appear. All code blocks are complete; all commands are exact; no "implement details" or "similar to".

**Out-of-scope / deferred (matches spec):**
- Jira destination support for `spec_path`/`plan_path`: not in this plan. The field will pass through FS, but Jira sync of the new fields is deferred to a follow-up.
- `.claude/rules/` advisory text: written by the existing `init` skill via the rule template (Task 9 covers the template; no init logic changes).
- Cross-plugin orchestration rules (e.g. "after writing-plans, run from-plan") live in `p-flow:rules`, which is the third follow-up spec — not this plan.
