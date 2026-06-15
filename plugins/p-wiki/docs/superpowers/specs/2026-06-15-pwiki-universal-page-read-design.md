# Design: `pwiki get` — universal page-content read

**Date:** 2026-06-15
**Status:** Approved (brainstorming)
**Targets:** `plugins/p-wiki` 4.7.1 → 4.8.0 (minor — additive CLI command + skill edits, no removals/renames)

---

## 1. Goal

Expose the existing `readPage()` capability as a CLI command so that reading a wiki **page** works the same way regardless of storage backend (filesystem or Confluence), and switch the skills to use it instead of the built-in `Read` tool for page reads.

### 1.1 Pain addressed

`readPage(path)` is implemented for both destinations (`destinations/fs.mjs#readPage`, `destinations/confluence.mjs#readPage`) and already returns the same shape `{ frontmatter, body, path }`. But it is not surfaced as a CLI command — only `sync` and `promote` call it internally. Skills read page bodies with the built-in `Read` tool (e.g. `query` Step 3, `reconcile` 4a), which can only open local files. In Confluence mode a page's path is `confluence://<type>/<slug>`, which `Read` cannot open, so:

- `/p-wiki:query` cannot load full page bodies from Confluence (search returns only `excerpt`s).
- `/p-wiki:reconcile` cannot read the page it is meant to re-merge.
- `/p-wiki:compile` cannot read an existing page when updating it.

The read capability exists; it simply has no handle the agent can call. This design adds that handle.

### 1.2 Non-goals

- **Writing page bodies to Confluence from skills.** The body-writing steps in `query` (answer page), `compile` (synthesis), and `reconcile` (merge) stay as FS edits. Rationale: the recommended topology authors on an FS-primary wiki and publishes to Confluence via `pwiki sync`, which writes bodies internally. Direct Confluence body authoring (`pwiki set-body`) is a separate future feature, only needed for Confluence-primary authoring.
- **Routing source / `raw/` / template / ingested-file reads through the CLI.** Those artifacts always live on the filesystem in both modes (`raw/` stays on disk by design; templates ship in the plugin bundle; ingested files are external). `Read` is correct for them and stays.
- **Changing `search` output.** Both backends' `search()` already emit a uniform `path` (`destinations/confluence.mjs:341` resolves `confluence://<type>/<slug>`; FS emits the repo-relative file path). The `search → get` chain works with no search changes.
- **A new skill or slash command.** `get` is a CLI primitive used by existing skills, not a user-facing skill (same rationale as `sync`).

---

## 2. Command

```
pwiki get <path> [--format=text|json]
```

- `<path>` (required) — exactly the `path` value that `search` returns for a result: a repo-relative `.md` path in FS mode, or `confluence://<type>/<slug>` in Confluence mode. Both are accepted by each destination's `readPage` via its `parsePath`.
- Resolves the primary destination (`resolveDestination(...).primary`), `await`s `readPage(path)` (FS is synchronous, Confluence is async — awaiting both is safe), and prints the result.

### 2.1 Output

- **`--format=text` (default):** the full reconstructed markdown — a YAML frontmatter fence followed by the body:
  ```
  ---
  <frontmatter serialized via tools/lib/yaml.mjs>
  ---

  <body>
  ```
  This is a drop-in replacement for what the `Read` tool returned when opening a `.md` file, so skills that only read-and-cite need minimal change.
- **`--format=json`:** `{ "path": <string>, "frontmatter": <object>, "body": <string> }` — emitted via the shared `emitJson` helper. For skills that must split frontmatter from body deterministically (`reconcile`, `compile` update) without parsing the YAML fence themselves.

Frontmatter is serialized with the same `tools/lib/yaml.mjs` serializer used by `new`/`set`, so the output is byte-identical regardless of backend — the point of "universal". (Key ordering in text mode is the serializer's canonical order, which may differ from the on-disk file; irrelevant for read-and-cite and for JSON consumers.)

### 2.2 Errors

- Missing page — `readPage` throws `page not found: <path>`. The handler maps it to `error.code: page-not-found` and exits 1 (this code is already documented in the `query` skill error table).
- Confluence auth / rate-limit / network / version errors propagate through the existing `mapErrorToCode`, matching every other Confluence-touching command.
- JSON error payloads follow the existing convention (`{ "error": { "code", "message" } }`).
- Exit codes follow the repo convention: 0 success, 1 user/env error (incl. not-found), 2 schema/conflict, 3 internal.

### 2.3 Registration

Add `'get'` to the `KNOWN` command list in `tools/pwiki.mjs` and a `if (command === 'get') { ... }` handler alongside the others.

---

## 3. Skill changes

Replace `Read` with `pwiki get` **only for wiki-page reads**:

| Skill | Spot | Change |
|---|---|---|
| `query` | Step 3 "Read top results" | For each `path` in search results, run `pwiki get <path>` (text) and use the returned content; cite by path. |
| `reconcile` | 4a "Read the page" | `pwiki get <path> --format=json` → use `frontmatter` + `body` (callout detection works on `body`). |
| `compile` | existing-page update read | When a page with the same id exists and must be updated, read it via `pwiki get` instead of `Read`. |

**Unchanged — `Read` stays** (always-FS artifacts):

- `compile` 4a — reads the **source** file (`raw/` or in-repo).
- `reconcile` 4b — reads the **source** files.
- `ingest` — reads the external/ingested file.
- `init` — reads the skill-bundle templates.

`allowed-tools` for the three changed skills already include `Bash(node:*)`, so no frontmatter permission change is needed. `Read` remains in `allowed-tools` because each of these skills still reads non-page files.

---

## 4. Testing (TDD)

- **CLI `get` (FS):** existing page → text output equals frontmatter fence + body; `--format=json` returns `{ path, frontmatter, body }` with the expected fields; missing page → exit 1 with `error.code: page-not-found`.
- **CLI `get` (Confluence, `fake-confluence` fixture):** existing page → body is the ADF→markdown conversion, frontmatter is reassembled from properties; uses the `confluence://<type>/<slug>` path form.
- **Round-trip with search:** a `search` result's `path` fed to `get` resolves the same page (both backends).
- `readPage` itself is already covered by the destination-contract suite; these tests add the CLI surface only.

---

## 5. Documentation

- `skills/_shared/templates/wiki-claude-md.template.md`, "CLI tool" section: add `pwiki get <path> [--format=json]` to the list of mechanical operations; update the "Generic Read/Write/Edit remain for body editing" note to say page **reads** now go through `pwiki get`, while `Read` stays for sources/templates and `Read`/`Edit` stay for FS body editing.
- No README change required (README does not enumerate CLI subcommands), but the Storage-backends section added earlier may optionally mention that page reads are backend-agnostic.

---

## 6. Backwards compatibility

- Additive command; no existing command renamed or removed.
- Skill interfaces unchanged from the user's perspective (same slash commands, same outputs).
- FS behavior is functionally identical — `pwiki get` returns the same content `Read` did; the only change is the transport (a `node` subprocess instead of the `Read` tool), which the user explicitly requested for uniformity.

Version bump: **4.7.1 → 4.8.0** (minor).
