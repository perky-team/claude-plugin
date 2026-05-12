# Marketplace + plugin static tests — design

**Date:** 2026-05-12
**Scope:** add an in-repo test suite that statically validates the marketplace manifest, every plugin manifest, every SKILL.md, and every template under `skills/_shared/templates/`. Runs locally with `npm test`. No CI, no end-to-end Claude invocation, no runtime execution of skills.

## Why static-only

The repo contains no executable code. Every artefact is either JSON, YAML frontmatter, or markdown body. The failure modes worth catching are all structural: stale paths in `marketplace.json`, frontmatter that drifts away from the directory name, a SKILL.md that references a template that no longer exists. End-to-end tests would require the `claude` CLI and an API key — that's a separate, future workstream.

## Stack

- **Runtime:** Node.js (LTS, ≥20).
- **Test runner:** Vitest.
- **Dependencies:** `gray-matter` (frontmatter), `semver` (version parsing). Both small, both stable. JSON parsing is built into Node.
- **No JSON Schema (yet).** The schemas are tiny enough to express as imperative assertions. Adding `ajv` is reasonable later if the marketplace grows.

## Layout

```
package.json              # devDeps: vitest, gray-matter, semver, @types/node
vitest.config.ts          # default config, only points at tests/
tsconfig.json             # node module resolution, strict: true
tests/
  helpers.ts              # findPlugins(), findSkills(), parseFrontmatter()
  marketplace.test.ts
  plugin-manifests.test.ts
  skills.test.ts
  templates.test.ts
```

Tests are written in TypeScript (`.test.ts`) — Vitest handles transpilation, and types make the helpers self-documenting.

## helpers.ts

Pure functions, no test state:

- `repoRoot()` — resolves `__dirname/..` once.
- `readMarketplace()` — parses `.claude-plugin/marketplace.json` and returns the typed object.
- `findPlugins()` — globs `plugins/*/.claude-plugin/plugin.json`, returns `{ dir, name, manifest }[]`.
- `findSkills(pluginDir)` — globs `skills/*/SKILL.md` under the plugin, **excluding `skills/_shared/`**, returns `{ dir, name, frontmatter, body, raw }[]`.
- `findTemplates(pluginDir)` — globs `skills/_shared/templates/*`.
- `parseFrontmatter(path)` — wraps `gray-matter`, throws a readable error on YAML parse failure.

Helpers throw on missing files — failure surfaces inside the asserting test, with a sane stack.

## Test files

### marketplace.test.ts

Reads `.claude-plugin/marketplace.json` once in a `beforeAll`. Then:

- `marketplace.json` is valid JSON.
- Top-level has `name: string`, `plugins: array`.
- For each `plugins[i]`:
  - `name`, `source`, `description` all present and non-empty strings.
  - `source` is a relative path that resolves to an existing directory.
  - That directory contains `.claude-plugin/plugin.json`.
  - The plugin's `plugin.json` `name` matches `plugins[i].name`.
- No duplicate `plugins[].name` values.
- Repo-root `README.md` mentions each plugin name (case-sensitive substring match) — guards against rename drift.

### plugin-manifests.test.ts

For each plugin from `findPlugins()`:

- `plugin.json` is valid JSON.
- Required: `name`, `version`, `description` — all non-empty strings.
- `name` matches the plugin directory name.
- `name` is kebab-case (regex `^[a-z][a-z0-9-]*[a-z0-9]$`).
- `version` parses as semver (`semver.valid`).
- A `README.md` exists at the plugin root and is non-empty (> 50 chars to catch placeholder files).

### skills.test.ts

For each plugin, for each skill from `findSkills(pluginDir)`:

- SKILL.md exists, non-empty.
- Frontmatter parses without YAML error.
- Required frontmatter fields: `name`, `description` — both non-empty strings.
- `name` matches the skill's parent directory name.
- `description` is at least 30 characters (catches stubs).
- If `allowed-tools` is present, it's a non-empty string.
- If `argument-hint` is present, it's a string.
- Markdown body (after frontmatter) is non-empty (> 100 chars — catches empty stub files).

Convention checks demoted to warnings would require a custom reporter. Skip for now: keep everything as hard assertions or omit. The "Use when…" convention check is **omitted** — too easy to false-positive against legitimate phrasings.

### templates.test.ts

For each plugin:

- Every file under `skills/_shared/templates/` is non-empty.
- For each SKILL.md, regex-extract every `${CLAUDE_SKILL_DIR}/../_shared/templates/<filename>` reference and assert the file exists.
- Inverse check: every template file is referenced by at least one SKILL.md. Failure = dead template. Hard assertion — drives cleanup.

The regex is tightened to: `\$\{CLAUDE_SKILL_DIR\}/\.\./_shared/templates/[^\s\`)]+`. Matches end at whitespace, backtick, or closing paren.

## package.json

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
    "@types/node": "^20.0.0",
    "gray-matter": "^4.0.3",
    "semver": "^7.6.0",
    "@types/semver": "^7.5.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

`type: module` so test files can use ESM imports without `.mjs` gymnastics. `private: true` since this isn't a publishable package.

## .gitignore additions

```
node_modules/
```

(Nothing else generated.)

## Out of scope

- GitHub Actions / any CI wiring.
- `claude plugin validate .` integration.
- End-to-end skill invocation against fixture wikis.
- JSON Schema files.
- Linting markdown body content (e.g., heading hierarchy).
- The `lint` skill's own logic — that's runtime behaviour and not testable statically.

## Risks / open questions

- **Helper discovery is path-shaped.** If someone adds `plugins/foo/sub/bar/.claude-plugin/plugin.json` (nested), the glob `plugins/*/.claude-plugin/plugin.json` won't catch it. Acceptable — marketplace convention is one level deep.
- **Cross-OS path separators.** All globs use forward slashes; Node's `path.posix` is used for portable comparisons. Tested on Windows.
- **Dependency footprint.** Three small devDeps (`vitest`, `gray-matter`, `semver`). `node_modules` will be ~40 MB. The user already runs Node tooling, so this is fine.
