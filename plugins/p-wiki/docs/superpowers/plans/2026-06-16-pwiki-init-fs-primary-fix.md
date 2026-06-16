# pwiki init FS-primary + Confluence-mirror Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pwiki init --mirror-confluence …` (no `--confluence`) produce the documented `{ primary: "fs", mirrors: ["confluence-mirror"], … }` config, fixing the code↔docs desync.

**Architecture:** Rewrite `initConfluence` to branch on whether a Confluence *primary* was requested (`--confluence`) vs only a Confluence *mirror*. Extract the duplicated Confluence-block resolution into one `resolveConfluenceBlock` helper. Relax the dispatch guard so `--mirror-confluence` alone is accepted.

**Tech Stack:** Node ESM (`tools/pwiki.mjs`), Vitest, `createFakeConfluence` fake transport.

---

## Reference: exact code

These blocks are referenced by the tasks below. Match them verbatim.

**`resolveConfluenceBlock` helper** (insert in `tools/pwiki.mjs` above `initConfluence`):

```js
async function resolveConfluenceBlock(transport, email, token, { site, space, parent }) {
  const http = createHttpClient({ baseUrl: site, email, token, transport });
  const spaceRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(space)}`);
  const spaceObj = spaceRes.body?.results?.[0];
  if (!spaceObj) emitJson({ error: { code: 'config-invalid', message: `space ${space} not found` } }, 1);

  let rootPageId;
  if (/^\d+$/.test(parent)) {
    rootPageId = parent;
    await http.get(`/wiki/api/v2/pages/${rootPageId}`);
  } else {
    const cql = `title = "${parent.replace(/"/g, '\\"')}" AND space = "${space}"`;
    const r = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=2`);
    const hits = r.body?.results ?? [];
    if (hits.length === 0) emitJson({ error: { code: 'config-invalid', message: `parent page "${parent}" not found in space ${space} — create it in UI first` } }, 1);
    if (hits.length > 1) emitJson({ error: { code: 'config-invalid', message: `parent page title ambiguous (${hits.length} matches) — pass numeric ID instead` } }, 1);
    rootPageId = hits[0].content?.id ?? hits[0].id;
  }

  const subParents = {};
  for (const type of ['concept', 'person', 'source', 'query']) {
    subParents[type] = await ensureSubParent(http, spaceObj.id, rootPageId, type);
  }
  return { kind: 'confluence', siteUrl: site, spaceKey: space, spaceId: spaceObj.id, rootPageId, subParents };
}
```

**New `initConfluence` body** (replaces the current `initConfluence`, lines ~121-202):

```js
export async function initConfluence(args, _opts = {}) {
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) die('PWIKI_CONFLUENCE_EMAIL and PWIKI_CONFLUENCE_TOKEN required', 1);
  const root = findWikiRoot(process.cwd());
  if (!root) die('not inside a p-wiki repo (no docs/wiki/CLAUDE.md found)', 1);

  const transport = _opts.transport ?? makeRealTransport();
  const destinations = {};
  const mirrors = [];
  let primaryName;

  if (args.confluence) {
    const site = args.site, space = args.space, parent = args.parent;
    if (!site || !space || !parent) die('--site, --space, and --parent required', 1);
    destinations.confluence = await resolveConfluenceBlock(transport, email, token, { site, space, parent });
    primaryName = 'confluence';
  } else {
    destinations.fs = { kind: 'fs' };
    primaryName = 'fs';
  }

  if (args['mirror-fs']) {
    destinations.fs = { kind: 'fs' };
    mirrors.push('fs');
  }

  if (args['mirror-confluence']) {
    const site = args['mirror-site'], space = args['mirror-space'], parent = args['mirror-parent'];
    if (!site || !space || !parent) die('--mirror-confluence requires --mirror-site, --mirror-space, --mirror-parent', 1);
    destinations['confluence-mirror'] = await resolveConfluenceBlock(transport, email, token, { site, space, parent });
    mirrors.push('confluence-mirror');
  }

  const config = { primary: primaryName, mirrors, destinations };
  const v = validateConfig(config);
  if (!v.ok) emitJson({ error: { code: 'internal', message: v.error } }, 3);
  writeConfig(root, config);
  emitJson({ ok: true, configPath: 'docs/wiki/.pwiki.json', primary: primaryName, mirrors }, 0);
}
```

**New dispatch guard** (replaces the `init` case body, line ~466):

```js
  if (command === 'init') {
    if (!args.confluence && !args['mirror-confluence']) die('use the /p-wiki:init skill for FS scaffolding; only --confluence is supported here', 1);
    await initConfluence(args);
  }
```

---

## Task 1: Failing tests for FS-primary + Confluence-mirror

**Files:**
- Test: `tools/__tests__/cli-init-confluence.test.ts` (add two `it` blocks inside the existing `describe('initConfluence', …)`)

- [ ] **Step 1: Write the failing tests**

Add inside the `describe('initConfluence', () => { … })` block:

```ts
  it('writes v3 shape with fs primary and confluence mirror', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    try {
      await initConfluence({
        'mirror-confluence': true, 'mirror-site': 'https://x.atlassian.net',
        'mirror-space': 'ENG', 'mirror-parent': '200',
      }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(onDisk.primary).toBe('fs');
    expect(onDisk.mirrors).toEqual(['confluence-mirror']);
    expect(onDisk.destinations.fs).toEqual({ kind: 'fs' });
    const cm = onDisk.destinations['confluence-mirror'];
    expect(cm.kind).toBe('confluence');
    expect(cm.siteUrl).toBe('https://x.atlassian.net');
    expect(cm.spaceKey).toBe('ENG');
    expect(cm.spaceId).toBe('100');
    expect(cm.rootPageId).toBe('200');
    for (const t of ['concept', 'person', 'source', 'query']) {
      expect(typeof cm.subParents[t]).toBe('string');
      expect(cm.subParents[t]).toBeTruthy();
    }
  });

  it('init --mirror-confluence is idempotent (same config, no new sub-parents)', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    const run = async () => {
      try {
        await initConfluence({
          'mirror-confluence': true, 'mirror-site': 'https://x.atlassian.net',
          'mirror-space': 'ENG', 'mirror-parent': '200',
        }, { transport: fake.transport });
      } catch (e: any) {
        expect(e.message).toBe('exit:0');
      }
    };
    await run();
    const first = readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8');
    const sizeAfterFirst = fake.pageById.size;
    await run();
    const second = readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8');
    expect(second).toBe(first);
    expect(fake.pageById.size).toBe(sizeAfterFirst);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-init-confluence.test.ts`
Expected: the two new tests FAIL. The first dies at `--site, --space, and --parent required` (current code requires them unconditionally), so no `.pwiki.json` is written and `readFileSync` throws / assertions fail.

- [ ] **Step 3: Commit the red tests**

```bash
git add plugins/p-wiki/tools/__tests__/cli-init-confluence.test.ts
git commit -m "test(p-wiki): failing tests for init FS-primary + Confluence-mirror"
```

---

## Task 2: Implement the fix

**Files:**
- Modify: `tools/pwiki.mjs` — add `resolveConfluenceBlock`, replace `initConfluence`, relax `init` guard, bump `VERSION`.

- [ ] **Step 1: Check for tests asserting the old mirror error wording**

Run: `cd plugins/p-wiki && grep -rn "mirror space\|mirror parent page" tools/__tests__/`
Expected: no matches. (The helper unifies the not-found/ambiguous messages to the non-prefixed wording; if a test asserts the old `mirror space … not found` text, update it to the unified message.)

- [ ] **Step 2: Add `resolveConfluenceBlock` helper**

Insert the **`resolveConfluenceBlock` helper** block (see Reference) immediately above `export async function initConfluence`.

- [ ] **Step 3: Replace `initConfluence` body**

Replace the entire current `initConfluence` function with the **New `initConfluence` body** block (see Reference).

- [ ] **Step 4: Relax the dispatch guard**

Replace the `init` case body with the **New dispatch guard** block (see Reference).

- [ ] **Step 5: Bump `VERSION`**

Change `const VERSION = '3.2.1';` to `const VERSION = '3.2.2';`.

- [ ] **Step 6: Run the init test file**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-init-confluence.test.ts`
Expected: all four tests PASS (two new + the two pre-existing Confluence-primary cases).

- [ ] **Step 7: Commit**

```bash
git add plugins/p-wiki/tools/pwiki.mjs
git commit -m "fix(p-wiki): init produces FS-primary config for --mirror-confluence; dedupe Confluence block resolution"
```

---

## Task 3: Guard subprocess tests + version assertion

**Files:**
- Modify: `tools/__tests__/cli-entry.test.ts`

- [ ] **Step 1: Write the guard tests and update the version assertion**

Update the version assertion:

```ts
    expect(r.stdout.trim()).toBe('3.2.2');
```

Add two `it` blocks inside `describe('pwiki CLI entry', …)`:

```ts
  it('init without confluence flags exits 1 with the guard message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwiki-init-guard-'));
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    const r = spawnSync('node', [cli, 'init'], { cwd: dir, encoding: 'utf-8' });
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only --confluence is supported/);
  });

  it('init --mirror-confluence passes the guard (fails on missing env, not the guard)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwiki-init-guard2-'));
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    const r = spawnSync(
      'node',
      [cli, 'init', '--mirror-confluence', '--mirror-site=https://x', '--mirror-space=ENG', '--mirror-parent=200'],
      { cwd: dir, encoding: 'utf-8', env: { ...process.env, PWIKI_CONFLUENCE_EMAIL: '', PWIKI_CONFLUENCE_TOKEN: '' } },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/only --confluence is supported/);
    expect(r.stderr).toMatch(/PWIKI_CONFLUENCE_EMAIL/);
  });
```

- [ ] **Step 2: Run the entry test file**

Run: `cd plugins/p-wiki && npx vitest run tools/__tests__/cli-entry.test.ts`
Expected: all tests PASS (version + unknown-command + internal-error + two new guard tests).

- [ ] **Step 3: Commit**

```bash
git add plugins/p-wiki/tools/__tests__/cli-entry.test.ts
git commit -m "test(p-wiki): guard accepts --mirror-confluence; bump version assertion"
```

---

## Task 4: Bump plugin version

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Bump the version**

Change `"version": "4.8.1"` to `"version": "4.8.2"`.

- [ ] **Step 2: Commit**

```bash
git add plugins/p-wiki/.claude-plugin/plugin.json
git commit -m "chore(p-wiki): bump version to 4.8.2"
```

---

## Task 5: Align documentation

**Files:**
- Modify: `skills/init/SKILL.md` (step 2)
- Modify: `docs/superpowers/specs/2026-05-18-pwiki-v3-multi-destination-sync-design.md` (§6.1)
- Modify: `skills/_shared/templates/wiki-claude-md.template.md` (Multi-destination)
- Modify: `README.md`

- [ ] **Step 1: SKILL.md step 2**

In the "FS primary + Confluence mirror" branch, confirm the command is
`pwiki init --mirror-confluence --mirror-site=<…> --mirror-space=<…> --mirror-parent=<…>`
and that the parenthetical states the result names the destination `confluence-mirror`:
`primary: "fs", mirrors: ["confluence-mirror"]`. Adjust wording only if it diverges from CLI output.

- [ ] **Step 2: design §6.1**

Replace the phrase "adds a Confluence mirror under the name `confluence-mirror` (or `confluence` if the primary is FS)" with "adds a Confluence mirror under the name `confluence-mirror`". Add one sentence noting the FS-primary `init` branch is implemented as of the 2026-06-16 fix (link the new spec).

- [ ] **Step 3: template + README**

In `wiki-claude-md.template.md` Multi-destination section and `README.md`, ensure an FS-primary + Confluence-mirror example/shape is present and uses `confluence-mirror`. Add a short example if missing; do not duplicate the existing Confluence-primary one.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-wiki/skills/init/SKILL.md plugins/p-wiki/docs/superpowers/specs/2026-05-18-pwiki-v3-multi-destination-sync-design.md plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md plugins/p-wiki/README.md
git commit -m "docs(p-wiki): align init FS-primary + Confluence-mirror docs with behavior"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `cd plugins/p-wiki && npm test`
Expected: all suites green (E2E is gated off without `PWIKI_E2E_CONFLUENCE=1`).

- [ ] **Step 2: Validate the plugin**

Run: `cd plugins/p-wiki && claude plugin validate .`
Expected: no errors.

- [ ] **Step 3: Confirm completion**

Report the green test summary and validation result. Do not claim success without the actual command output.

---

## Self-Review

**Spec coverage:**
- Bug barriers 1-3 → Task 2 (guard, FS branch, dynamic primary). ✓
- Dedup `resolveConfluenceBlock` → Task 2. ✓
- FS-primary + Confluence-mirror shape + `validateConfig` → Task 1 test. ✓
- Idempotency → Task 1 test. ✓
- Guard relaxation proof → Task 3. ✓
- `confluence-mirror` naming → Task 1 assertion + Task 5 §6.1. ✓
- Versioning (patch) → Task 2 (VERSION) + Task 3 (assertion) + Task 4 (plugin.json). ✓
- Doc alignment → Task 5. ✓
- Full suite + validate → Task 6. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete.

**Type consistency:** `resolveConfluenceBlock(transport, email, token, { site, space, parent })` signature is identical in the helper definition and both call sites. Destination key `confluence-mirror` consistent in code and tests. Config shape `{ primary, mirrors, destinations }` matches `validateConfig`.
