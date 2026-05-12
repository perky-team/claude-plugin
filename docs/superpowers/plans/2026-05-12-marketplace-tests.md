# Marketplace + plugin static tests — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node.js + Vitest static test suite at the repo root that validates `marketplace.json`, every `plugin.json`, every `SKILL.md`, and every template under `skills/_shared/templates/`. Runs via `npm test`.

**Architecture:** A single root-level `package.json`/`tsconfig.json` and a `tests/` directory with one helpers module and four test files (one per concern). No globbing library — `node:fs` `readdirSync` + path joins. No CI wiring. ESM throughout (`"type": "module"`).

**Tech Stack:** Node ≥20 (system has v24), TypeScript ^5, Vitest ^3, `gray-matter` ^4, `semver` ^7.

**TDD note:** The "implementation under test" here is the existing repo data (manifests, frontmatter, templates) — already in good shape. Each test should pass on first run against current data. The discipline applied: after each test file is committed, the engineer runs **one negative-validation pass** (Task 8) where each check is forced to fail by temporary mutation, then reverted via `git restore`. This is the equivalent of "see the test fail first" for assertion-over-data tests.

**Specification reference:** [`docs/superpowers/specs/2026-05-12-marketplace-tests-design.md`](../specs/2026-05-12-marketplace-tests-design.md).

---

## File map

| Path | Created/Modified | Responsibility |
|---|---|---|
| `package.json` | Create | devDeps + `npm test` script |
| `tsconfig.json` | Create | ESM + strict TS for the test code |
| `.gitignore` | Modify | Add `node_modules/` |
| `tests/helpers.ts` | Create | `repoRoot`, `readMarketplace`, `findPlugins`, `findSkills`, `findTemplates`, `parseFrontmatter` |
| `tests/marketplace.test.ts` | Create | Marketplace-level invariants |
| `tests/plugin-manifests.test.ts` | Create | Per-plugin `plugin.json` invariants |
| `tests/skills.test.ts` | Create | Per-skill SKILL.md invariants |
| `tests/templates.test.ts` | Create | Template ↔ SKILL.md reference graph |
| `README.md` | Modify | Add a "Tests" section |

---

## Task 1: Bootstrap the npm project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "perky-team-claude-plugin-tests",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/semver": "^7.5.0",
    "gray-matter": "^4.0.3",
    "semver": "^7.6.0",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["tests/**/*.ts"]
}
```

`"module": "NodeNext"` is required for `import.meta.url` to type-check correctly.

- [ ] **Step 3: Add `node_modules/` to `.gitignore`**

Read the current `.gitignore` and append a section. Final file should end with:

```
# OS junk
.DS_Store
Thumbs.db
desktop.ini

# Editor caches
.vscode/
.idea/
*.swp
*.swo

# Node
node_modules/
```

- [ ] **Step 4: Install deps**

Run: `npm install`
Expected: completes with no errors, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 5: Smoke-check the toolchain**

Run: `npx vitest --version`
Expected: prints a `3.x.y` version string and exits 0.

Run: `npx tsc --noEmit`
Expected: exits 0 silently (no `.ts` files yet — just validates config).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore
git commit -m "test: scaffold Node + Vitest test project"
```

---

## Task 2: Implement `tests/helpers.ts`

**Files:**
- Create: `tests/helpers.ts`

- [ ] **Step 1: Write `tests/helpers.ts`**

```ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const here = dirname(fileURLToPath(import.meta.url));

export const repoRoot = (): string => resolve(here, '..');

export interface MarketplaceEntry {
  name: string;
  source: string;
  description: string;
}

export interface Marketplace {
  name: string;
  description?: string;
  owner?: { name?: string; email?: string };
  plugins: MarketplaceEntry[];
}

export const readMarketplace = (): { path: string; data: Marketplace } => {
  const path = join(repoRoot(), '.claude-plugin', 'marketplace.json');
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Marketplace;
  return { path, data };
};

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: { name?: string; email?: string };
}

export interface Plugin {
  dir: string;
  name: string;
  manifestPath: string;
  manifest: PluginManifest;
  readmePath: string;
}

const listDirs = (parent: string): string[] =>
  existsSync(parent)
    ? readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

export const findPlugins = (): Plugin[] => {
  const pluginsDir = join(repoRoot(), 'plugins');
  return listDirs(pluginsDir)
    .map((name): Plugin | null => {
      const dir = join(pluginsDir, name);
      const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
      if (!existsSync(manifestPath)) return null;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      return {
        dir,
        name,
        manifestPath,
        manifest,
        readmePath: join(dir, 'README.md'),
      };
    })
    .filter((p): p is Plugin => p !== null);
};

export interface Skill {
  dir: string;
  name: string;
  skillMdPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export const findSkills = (pluginDir: string): Skill[] => {
  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return listDirs(skillsDir)
    .filter((name) => !name.startsWith('_'))
    .map((name): Skill | null => {
      const dir = join(skillsDir, name);
      const skillMdPath = join(dir, 'SKILL.md');
      if (!existsSync(skillMdPath)) return null;
      const raw = readFileSync(skillMdPath, 'utf-8');
      const parsed = matter(raw);
      return {
        dir,
        name,
        skillMdPath,
        frontmatter: parsed.data,
        body: parsed.content,
        raw,
      };
    })
    .filter((s): s is Skill => s !== null);
};

export interface Template {
  path: string;
  filename: string;
  content: string;
}

export const findTemplates = (pluginDir: string): Template[] => {
  const templatesDir = join(pluginDir, 'skills', '_shared', 'templates');
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = join(templatesDir, e.name);
      return {
        path: p,
        filename: e.name,
        content: readFileSync(p, 'utf-8'),
      };
    });
};
```

**Note vs spec:** The spec listed `parseFrontmatter(path)` as a standalone helper. In this implementation it's folded into `findSkills` (which calls `matter()` once per skill and returns `frontmatter`, `body`, `raw` already split). No test consumes frontmatter parsing outside the skill-discovery flow, so a separate export would be dead code. Add it back if a future test needs to parse arbitrary YAML frontmatter from a non-skill file.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.ts
git commit -m "test: add helpers for marketplace/plugin/skill/template discovery"
```

---

## Task 3: `tests/marketplace.test.ts`

**Files:**
- Create: `tests/marketplace.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  type Marketplace,
  type PluginManifest,
  readMarketplace,
  repoRoot,
} from './helpers.js';

describe('marketplace.json', () => {
  let marketplace: Marketplace;
  let marketplacePath: string;

  beforeAll(() => {
    const m = readMarketplace();
    marketplace = m.data;
    marketplacePath = m.path;
  });

  it('exists at .claude-plugin/marketplace.json', () => {
    expect(existsSync(marketplacePath)).toBe(true);
  });

  it('is valid JSON (already parsed by helper)', () => {
    expect(typeof marketplace).toBe('object');
    expect(marketplace).not.toBeNull();
  });

  it('has a non-empty top-level "name" string', () => {
    expect(typeof marketplace.name).toBe('string');
    expect(marketplace.name.length).toBeGreaterThan(0);
  });

  it('has a "plugins" array', () => {
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it('contains no duplicate plugin names', () => {
    const names = marketplace.plugins.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  describe('each plugin entry', () => {
    it('has non-empty name, source, description strings', () => {
      for (const entry of marketplace.plugins) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.source).toBe('string');
        expect(entry.source.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string');
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });

    it('source resolves to an existing directory', () => {
      for (const entry of marketplace.plugins) {
        const abs = join(repoRoot(), entry.source);
        expect(existsSync(abs), `${entry.source} should exist`).toBe(true);
        expect(statSync(abs).isDirectory(), `${entry.source} should be a directory`).toBe(true);
      }
    });

    it('source directory contains .claude-plugin/plugin.json', () => {
      for (const entry of marketplace.plugins) {
        const manifestPath = join(repoRoot(), entry.source, '.claude-plugin', 'plugin.json');
        expect(existsSync(manifestPath), `missing manifest at ${manifestPath}`).toBe(true);
      }
    });

    it('plugin.json name matches the marketplace entry name', () => {
      for (const entry of marketplace.plugins) {
        const manifestPath = join(repoRoot(), entry.source, '.claude-plugin', 'plugin.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
        expect(manifest.name, `${entry.source} plugin.json name`).toBe(entry.name);
      }
    });
  });

  describe('repo README plugins table', () => {
    it('lists every plugin from the marketplace', () => {
      const readme = readFileSync(join(repoRoot(), 'README.md'), 'utf-8');
      const lines = readme.split(/\r?\n/);
      const headerIdx = lines.findIndex((l) => /^\s*\|\s*Plugin\s*\|/i.test(l));
      expect(headerIdx, 'README must contain a "| Plugin |" header row').toBeGreaterThanOrEqual(0);

      // Skip header and the |---|---| separator row.
      const rowLines = lines.slice(headerIdx + 2).filter((l) => l.trim().startsWith('|'));
      const firstCells = rowLines.map((l) => l.split('|')[1]?.trim() ?? '');

      for (const entry of marketplace.plugins) {
        const found = firstCells.some((cell) => cell.includes(entry.name));
        expect(found, `README plugins table must mention "${entry.name}" in the first column`).toBe(true);
      }
    });
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `npm test -- tests/marketplace.test.ts`
Expected: all tests pass against the current `marketplace.json` and `README.md`.

- [ ] **Step 3: Commit**

```bash
git add tests/marketplace.test.ts
git commit -m "test: validate marketplace.json + README plugins table"
```

---

## Task 4: `tests/plugin-manifests.test.ts`

**Files:**
- Create: `tests/plugin-manifests.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import semver from 'semver';
import { findPlugins } from './helpers.js';

const KEBAB_CASE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const README_MIN_CHARS = 50;

describe('plugin manifests', () => {
  const plugins = findPlugins();

  it('at least one plugin exists', () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    describe(`plugin: ${plugin.name}`, () => {
      it('plugin.json has non-empty name, version, description', () => {
        expect(typeof plugin.manifest.name).toBe('string');
        expect(plugin.manifest.name.length).toBeGreaterThan(0);
        expect(typeof plugin.manifest.version).toBe('string');
        expect(plugin.manifest.version.length).toBeGreaterThan(0);
        expect(typeof plugin.manifest.description).toBe('string');
        expect(plugin.manifest.description.length).toBeGreaterThan(0);
      });

      it('plugin.json name matches the plugin directory name', () => {
        expect(plugin.manifest.name).toBe(plugin.name);
      });

      it('plugin.json name is kebab-case', () => {
        expect(plugin.manifest.name).toMatch(KEBAB_CASE);
      });

      it('plugin.json version parses as semver', () => {
        expect(semver.valid(plugin.manifest.version)).not.toBeNull();
      });

      it('plugin has a README.md', () => {
        expect(existsSync(plugin.readmePath)).toBe(true);
        expect(statSync(plugin.readmePath).isFile()).toBe(true);
      });

      it('plugin README.md is non-trivial (>50 chars)', () => {
        const content = readFileSync(plugin.readmePath, 'utf-8');
        expect(content.length).toBeGreaterThan(README_MIN_CHARS);
      });
    });
  }
});
```

- [ ] **Step 2: Run the suite**

Run: `npm test -- tests/plugin-manifests.test.ts`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/plugin-manifests.test.ts
git commit -m "test: validate per-plugin plugin.json and README"
```

---

## Task 5: `tests/skills.test.ts`

**Files:**
- Create: `tests/skills.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, expect, it } from 'vitest';
import { findPlugins, findSkills } from './helpers.js';

const DESCRIPTION_MIN_CHARS = 30;
const BODY_MIN_CHARS = 100;

describe('skills', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const skills = findSkills(plugin.dir);

    describe(`plugin: ${plugin.name}`, () => {
      it('has at least one skill', () => {
        expect(skills.length).toBeGreaterThan(0);
      });

      for (const skill of skills) {
        describe(`skill: ${skill.name}`, () => {
          it('SKILL.md raw content is non-empty', () => {
            expect(skill.raw.length).toBeGreaterThan(0);
          });

          it('frontmatter has a string "name"', () => {
            expect(typeof skill.frontmatter.name).toBe('string');
            expect((skill.frontmatter.name as string).length).toBeGreaterThan(0);
          });

          it('frontmatter.name matches the skill directory name', () => {
            expect(skill.frontmatter.name).toBe(skill.name);
          });

          it('frontmatter has a non-empty string "description"', () => {
            expect(typeof skill.frontmatter.description).toBe('string');
            expect((skill.frontmatter.description as string).length).toBeGreaterThan(DESCRIPTION_MIN_CHARS);
          });

          it('frontmatter "allowed-tools" is a non-empty string when present', () => {
            const v = skill.frontmatter['allowed-tools'];
            if (v !== undefined) {
              expect(typeof v).toBe('string');
              expect((v as string).length).toBeGreaterThan(0);
            }
          });

          it('frontmatter "argument-hint" is a string when present', () => {
            const v = skill.frontmatter['argument-hint'];
            if (v !== undefined) {
              expect(typeof v).toBe('string');
            }
          });

          it('markdown body is non-trivial (>100 chars)', () => {
            expect(skill.body.trim().length).toBeGreaterThan(BODY_MIN_CHARS);
          });
        });
      }
    });
  }
});
```

- [ ] **Step 2: Run the suite**

Run: `npm test -- tests/skills.test.ts`
Expected: all five skills (`init`, `ingest`, `compile`, `query`, `lint`) report passing tests.

- [ ] **Step 3: Commit**

```bash
git add tests/skills.test.ts
git commit -m "test: validate SKILL.md frontmatter and body across plugins"
```

---

## Task 6: `tests/templates.test.ts`

**Files:**
- Create: `tests/templates.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPlugins, findSkills, findTemplates } from './helpers.js';

// Matches every `${CLAUDE_SKILL_DIR}/../_shared/templates/<filename>` reference.
// The filename runs up to whitespace, backtick, or closing paren.
const TEMPLATE_REF = /\$\{CLAUDE_SKILL_DIR\}\/\.\.\/_shared\/templates\/([^\s`)]+)/g;

describe('templates', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const templates = findTemplates(plugin.dir);
    const skills = findSkills(plugin.dir);

    // Aggregate every template filename referenced by any skill in this plugin.
    const referenced = new Set<string>();
    for (const skill of skills) {
      for (const match of skill.raw.matchAll(TEMPLATE_REF)) {
        referenced.add(match[1]);
      }
    }

    describe(`plugin: ${plugin.name}`, () => {
      if (templates.length > 0) {
        for (const tpl of templates) {
          it(`template "${tpl.filename}" is non-empty`, () => {
            expect(tpl.content.trim().length).toBeGreaterThan(0);
          });

          it(`template "${tpl.filename}" is referenced by at least one SKILL.md`, () => {
            expect(referenced.has(tpl.filename), `${tpl.filename} is not referenced by any SKILL.md (dead template)`).toBe(true);
          });
        }
      }

      for (const skill of skills) {
        const refsInSkill = [...skill.raw.matchAll(TEMPLATE_REF)].map((m) => m[1]);
        for (const ref of refsInSkill) {
          it(`SKILL.md "${skill.name}" references existing template "${ref}"`, () => {
            const tplPath = join(plugin.dir, 'skills', '_shared', 'templates', ref);
            expect(existsSync(tplPath), `template not found: ${tplPath}`).toBe(true);
          });
        }
      }
    });
  }
});
```

- [ ] **Step 2: Run the suite**

Run: `npm test -- tests/templates.test.ts`
Expected: all four `p-wiki` templates (`p-wiki-rule`, `wiki-claude-md`, `wiki-readme`, `wiki-index`) report both their existence and referenced-by checks passing.

- [ ] **Step 3: Commit**

```bash
git add tests/templates.test.ts
git commit -m "test: validate template ↔ SKILL.md reference graph"
```

---

## Task 7: Document tests in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Tests" section before "Repository layout"**

Locate the current section break before `## Repository layout` and insert:

```markdown
## Tests

Static validation of `marketplace.json`, every `plugin.json`, every `SKILL.md`, and template references.

```bash
npm install   # first time only
npm test
```

Tests are static — no network, no `claude` CLI, no fixtures. See [`docs/superpowers/specs/2026-05-12-marketplace-tests-design.md`](./docs/superpowers/specs/2026-05-12-marketplace-tests-design.md) for the rationale.
```

- [ ] **Step 2: Run the full suite once to confirm nothing regressed**

Run: `npm test`
Expected: all four test files pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document npm test entry point in repo README"
```

---

## Task 8: Negative validation pass

Confirm each check actually catches what it claims to. **All mutations are reverted via `git restore` — nothing in this task gets committed.**

For each item below: make the temporary edit, run the suggested `npm test -- <file>` command, confirm at least one assertion fails with a useful message, then `git restore <file>` to undo.

- [ ] **Step 1: Marketplace — break plugin name mismatch**

Edit `.claude-plugin/marketplace.json`: change the `p-wiki` entry's `"name"` to `"p-wikix"`.
Run: `npm test -- tests/marketplace.test.ts`
Expected: failure on "plugin.json name matches the marketplace entry name".
Revert: `git restore .claude-plugin/marketplace.json`

- [ ] **Step 2: Marketplace — break the README plugins table**

Edit `README.md`: remove the row containing `p-wiki` from the plugins table.
Run: `npm test -- tests/marketplace.test.ts`
Expected: failure on "README plugins table … must mention `p-wiki`".
Revert: `git restore README.md`

- [ ] **Step 3: Plugin manifest — break semver**

Edit `plugins/p-wiki/.claude-plugin/plugin.json`: change `"version"` to `"not-a-version"`.
Run: `npm test -- tests/plugin-manifests.test.ts`
Expected: failure on "version parses as semver".
Revert: `git restore plugins/p-wiki/.claude-plugin/plugin.json`

- [ ] **Step 4: Skill frontmatter — rename mismatch**

Edit `plugins/p-wiki/skills/lint/SKILL.md`: change the `name:` frontmatter field from `lint` to `linter`.
Run: `npm test -- tests/skills.test.ts`
Expected: failure on "frontmatter.name matches the skill directory name".
Revert: `git restore plugins/p-wiki/skills/lint/SKILL.md`

- [ ] **Step 5: Template ref — break a reference**

Edit `plugins/p-wiki/skills/init/SKILL.md`: rename one referenced template in the body, e.g. `wiki-readme.template.md` → `wiki-readme-OOPS.template.md`.
Run: `npm test -- tests/templates.test.ts`
Expected: failure on `references existing template "wiki-readme-OOPS.template.md"`.
Revert: `git restore plugins/p-wiki/skills/init/SKILL.md`

- [ ] **Step 6: Dead template — add an unused one**

Create a new file: `plugins/p-wiki/skills/_shared/templates/orphan.md` with content `# orphan` (no SKILL.md references it).
Run: `npm test -- tests/templates.test.ts`
Expected: failure on `orphan.md is not referenced by any SKILL.md`.
Revert: `rm plugins/p-wiki/skills/_shared/templates/orphan.md` (or `Remove-Item` on PowerShell).

- [ ] **Step 7: Final clean run**

Run: `git status`
Expected: working tree clean.

Run: `npm test`
Expected: all tests pass.

No commit — this task only verifies, doesn't change anything.

---

## Self-review checklist (for the engineer)

Before declaring done:

- `npm test` exits 0 on a clean working tree.
- `git status` shows no untracked artefacts other than `node_modules/` (which is in `.gitignore`).
- The spec's "Out of scope" list is honoured — no CI yml file, no `ajv`, no `claude plugin validate` invocation in the test suite.
- The "Workflow consequence" callout in the spec is still accurate: adding a template without a SKILL.md reference WILL break the suite, by design.
