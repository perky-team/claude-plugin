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

- `<path>` (required) — exactly the `path` value that `search` returns for a result: a repo-relative `.md` path in FS mode, or `confluence://<type>/<slug>` in Confluence mode. Each backend's `readPage` accepts its own form: FS joins the repo-relative path directly (`fs.mjs:57`, no `parsePath`); Confluence parses `confluence://<type>/<slug>` via `parsePath` (`identity.mjs:3-7`).
- Resolves the primary destination (`resolveDestination(...).primary`), `await`s `readPage(path)` (FS is synchronous, Confluence is async — `await` on the sync return is a no-op, so a single `await` is correct for both; note this in the handler so it isn't "fixed" later), and prints the result.

### 2.1 Output

- **`--format=text` (default):** the full reconstructed markdown — a YAML frontmatter fence followed by the body:
  ```
  ---
  <frontmatter>
  ---

  <body>
  ```
  Reconstructed via `serializeFrontmatter(frontmatter, body)` from `tools/lib/fm.mjs` — the same fence-producing serializer `new`/`set` use when writing FS files (`fs.mjs:52,133`). This gives the agent the same *content* it got from the `Read` tool, so skills that only read-and-cite need minimal change.
- **`--format=json`:** `{ "path": <string>, "frontmatter": <object>, "body": <string> }` — emitted via the shared `emitJson` helper. For skills that must split frontmatter from body deterministically (`reconcile`) without parsing the YAML fence themselves.
- Unknown `--format` values are treated as `text`, matching the convention in `lint`/`index`.

Note this is **content-equivalent, not byte-identical**, to a prior `Read` of an on-disk file: frontmatter comes out in the serializer's canonical key order (not the file's original order), and for Confluence the body is `adfToMarkdown(adf)` — a lossy ADF→markdown round-trip. Fine for read-and-cite and for JSON consumers; do not rely on exact byte equality with any source file.

### 2.2 Errors

The `get` handler wraps `readPage` in `try/catch` and does NOT rely on the top-level `mapErrorToCode` for the not-found case. Reason: `readPage` throws a plain `new Error('page not found: <path>')` with no `.status`/`.code`, and `mapErrorToCode` only emits `page-not-found` from `err.status === 404` (`pwiki.mjs:23`) — so a bare throw would fall through to `internal`/exit 3, contradicting the `query`/`reconcile` error tables. Therefore:

- **Missing page** — catch, match the `/^page not found:/` message, emit `{ "error": { "code": "page-not-found", "message": ... } }` and exit 1 explicitly (the same pattern `set`/`promote` use with `die`, `pwiki.mjs:335,348`).
- **Malformed path shape** (e.g. a non-`confluence://` arg in Confluence mode — `identity.mjs:5` throws "not a confluence:// path") — treat as a user error: exit 1 with a descriptive message, not `internal`/exit 3.
- **Confluence auth / rate-limit / network / version** errors — re-throw so the existing top-level `mapErrorToCode` handles them, matching every other Confluence-touching command (these DO carry `.status`/`.code`).
- JSON error payloads follow the existing convention (`{ "error": { "code", "message" } }`).
- Exit codes follow the repo convention: 0 success, 1 user/env error (incl. not-found and bad-path), 2 schema/conflict, 3 internal.

(Deliberately NOT extending `mapErrorToCode` to match the message globally: that would change exit codes for every other command that currently lets this string fall to `internal`. The fix is local to the `get` handler.)

### 2.3 Registration

Add `'get'` to the `KNOWN` command list in `tools/pwiki.mjs` and an `if (command === 'get') { ... }` handler alongside the others, with the local `try/catch` described in §2.2.

---

## 3. Skill changes

Replace `Read` with `pwiki get` **only for wiki-page reads**:

| Skill | Spot | Change |
|---|---|---|
| `query` | Step 3 "Read top results" (`query/SKILL.md:33`) | For each `path` in search results, run `pwiki get <path>` (text) and use the returned content; cite by path. |
| `reconcile` | 4a "Read the page" (`reconcile/SKILL.md:50-52`) | `pwiki get <path> --format=json` → use `frontmatter` + `body` (callout detection works on `body`). |

**`compile` is intentionally NOT changed.** Its update path (4d, `compile/SKILL.md:71-78`) runs `pwiki set` then "Edit the body to add facts" — there is no discrete page-**read** step to switch, and its body editing is FS-Edit-based (part of the write path, a non-goal here). Compile gains nothing from `get` without the separate body-write feature, so it stays as-is.

**Unchanged — `Read` stays** (always-FS artifacts):

- `compile` 4a — reads the **source** file (`raw/` or in-repo).
- `reconcile` 4b — reads the **source** files.
- `ingest` — reads the external/ingested file.
- `init` — reads the skill-bundle templates.

`allowed-tools` for the three changed skills already include `Bash(node:*)`, so no frontmatter permission change is needed. `Read` remains in `allowed-tools` because each of these skills still reads non-page files.

---

## 4. Testing (TDD)

- **CLI `get` (FS):** existing page → text output equals frontmatter fence + body; `--format=json` returns `{ path, frontmatter, body }` with the expected fields; missing page → exit 1 with `error.code: page-not-found`.
- **CLI `get` (Confluence, `fake-confluence` fixture):** existing page → body is the ADF→markdown conversion, frontmatter is reassembled from properties; uses the `confluence://<type>/<slug>` path form. **Fixture note:** a fresh CLI subprocess starts with an empty identity cache, so `readPage` resolves the numeric id via a `pageExists` CQL lookup before the v2 page GET (`confluence.mjs:211-215`); the fixture must serve that CQL search path, not only the page GET.
- **Round-trip with search:** a `search` result's `path` fed to `get` resolves the same page (both backends).
- **Not-found:** `get` of a missing page → exit 1, `error.code: page-not-found` (guards against the `mapErrorToCode` fall-through described in §2.2).
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
