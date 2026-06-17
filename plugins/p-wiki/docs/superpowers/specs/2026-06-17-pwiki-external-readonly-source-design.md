# Design: read-only external sources for p-wiki

**Date:** 2026-06-17
**Status:** Approved (brainstorming)
**Targets:** `plugins/p-wiki` 4.10.0 → 4.11.0 (minor — additive config field + CLI flag + skill edit, no removals/renames)

---

## 1. Goal

Let a p-wiki point at one or more **read-only sources** — additional p-wiki-formatted stores (a foreign Confluence space populated by another p-wiki, or another wiki folder on disk) — so that `search`, `query`, and `get` read from them alongside the wiki's own primary destination. p-wiki never writes to a source.

### 1.1 Pain addressed

A user has knowledge already living in a Confluence space (published there by another team's p-wiki) and wants their local p-wiki to answer questions using both their own pages and that shared space, without copying anything and without ever writing to the foreign space.

Today `search` and `get` resolve only `res.primary` (`pwiki.mjs:418`, `:214`); there is no way to read from a second store. Mirrors are write-targets, not read-inputs, so they don't fit.

### 1.2 Scope decisions (from brainstorming)

- **Topology:** a read-only source sits *alongside* the user's own wiki — `search`/`query` union results from primary + sources. It is not a standalone reader-only wiki.
- **Source content is p-wiki-formatted.** Sources are stores that p-wiki itself wrote elsewhere (FS wiki with frontmatter; Confluence space with `pwiki-*` content properties and the structural `subParents` tree). This is the crux that keeps the feature cheap: the **existing** `search`/`readPage`/`listPages` of both backends are reused unchanged. Reading arbitrary human-authored Confluence pages (no `pwiki-*` properties) is a **non-goal** — it would need a generic reader and is explicitly out of scope.
- **Command scope:** only `query` / `search` / `get` honor sources. Everything else (`compile`, `ingest`, `reconcile`, `sync`, `lint`, `new`, `promote`, `set`, `move`, `backlinks`, `init`) operates on `primary` only and never touches a source.

### 1.3 Non-goals

- Generic reading of non-p-wiki content (human-authored Confluence pages, arbitrary markdown). Out of scope; see §1.2.
- Writing to a source in any form.
- `lint` / cross-link checking across the source boundary.
- Per-source Confluence credentials. All `confluence` blocks share `PWIKI_CONFLUENCE_EMAIL` / `PWIKI_CONFLUENCE_TOKEN`; a source on a different Atlassian account with different creds is not supported. Documented as a limitation.
- Clickable citations for Confluence-source pages. Citing `confluence://type/slug` is not a real URL — this is a pre-existing limitation of primary-Confluence citing and is not addressed here.

---

## 2. Config schema

A new optional top-level `sources` array in `docs/wiki/.pwiki.json`, symmetric with `mirrors`. `mirrors` = where p-wiki writes a 1:1 copy; `sources` = stores p-wiki only reads.

```json
{
  "primary": "fs",
  "mirrors": [],
  "sources": ["team-confluence", "archived-wiki"],
  "destinations": {
    "fs": { "kind": "fs" },
    "team-confluence": {
      "kind": "confluence",
      "siteUrl": "https://acme.atlassian.net",
      "spaceKey": "KB", "spaceId": "12345", "rootPageId": "67890",
      "titlePrefix": "KB", "subParents": { "concept": "...", "person": "...", "source": "...", "query": "..." }
    },
    "archived-wiki": { "kind": "fs", "path": "C:/other/repo" }
  }
}
```

- **Confluence source** — an ordinary `confluence` block. No schema change: a foreign p-wiki Confluence space already carries `subParents` / `rootPageId` / `pwiki-*` properties, which is exactly what the existing reader needs.
- **FS source** — an `fs` block with a new optional `path` field: the root of another wiki on disk (the folder that contains `docs/wiki`), absolute or relative to the current repo root. For a primary/mirror `fs` block `path` is absent → current repo, as today.

### 2.1 Validation (`config.mjs`, `validateConfig`)

Add, after the existing `mirrors` checks:

- `sources` is optional; if present it must be an array of non-empty strings (same rule shape as `mirrors`).
- every name in `sources` must exist as a key in `destinations` (else `invalid` with a descriptive message → surfaced as `config-invalid`).
- source names must be **disjoint** from `primary` and from `mirrors`. A name appearing in both a write role and `sources` is a config error (roles are mutually exclusive — a store you mirror to is not a read-only input).
- for any `fs` block: if `path` is present it must be a non-empty string.

No migration is needed: absence of `sources` means an empty list, so every existing config stays valid. `readConfig`'s v2→v3 migration is untouched (migrated configs simply have no `sources`).

---

## 3. Resolution (`destination.mjs`, `resolveDestination`)

Mirror the existing lazy-mirror machinery for sources:

- After building `mirrors` / `mirrorNames`, build `sourceNames = [...(cfg.sources ?? [])]` and a `sources` Proxy that lazily constructs each source destination on first index access (identical Proxy pattern to `mirrors`, `destination.mjs:46-60`).
- Return shape gains two fields: `{ primary, primaryName, mirrors, mirrorNames, sources, sourceNames }`.
- `makeDestination` for `fs`: if the block has a `path`, resolve it to an absolute path (relative paths resolved against the current repo root) and pass it as the destination root — `createFsDestination({ root: <abs path> })`; otherwise pass the current `root` (unchanged behavior). FS reads/writes already join `docs/wiki` onto that root (`fs.mjs:21`), so a source root pointing at another repo Just Works.
- Confluence source: constructed exactly as today via `createConfluenceDestination`.

No reader code in `destinations/fs.mjs` or `destinations/confluence.mjs` changes.

---

## 4. `search` — union (`pwiki.mjs`, `command === 'search'`)

Replace the single-destination search with a primary-plus-sources union:

1. Resolve destinations. Run `primary.search(query, opts)`; tag each result with `source: "<primaryName>"`. Seed `total` and `results` from it.
2. For each source name in `sourceNames`, call its `search(query, opts)`, tag each result with `source: "<source name>"`, append to `results` (primary first), add its `total` to the running `total`.
3. `--limit` applies **per source** (each destination returns up to `limit`), so one store cannot starve another.
4. **Graceful degradation:** wrap each *source* search in try/catch. On error, skip that source's results and push `{ source, code, message }` onto a `warnings` array (`code` derived the same way `mapErrorToCode` derives it for Confluence errors). A failing source must not abort the whole search. A failing **primary** stays fatal (re-thrown to the top-level handler) — the user's own wiki must work.
5. Output JSON gains a `warnings` field: `{ query, total, results, warnings }`. `warnings` is `[]` when everything succeeded — always present so consumers needn't branch on its existence.

Each result is self-describing: it carries both `path` and `source`, so `query` can route `get` blindly without knowing the backend kind.

---

## 5. `get` — routing (`pwiki.mjs`, `getPage`)

Add a `--source=<name>` flag:

- Resolve the target destination: no flag (or `--source` equal to `primaryName`) → `res.primary`; a name present in `sourceNames` → the matching `res.sources[i]`; any other value → emit `{ error: { code: 'unknown-source', message } }` and exit 1.
- The rest of `getPage` (the `readPage` call, the not-found / bad-path message matching, text vs json output) is unchanged.
- An FS source resolves its repo-relative `path` against its own root; a Confluence source resolves `confluence://type/slug` via its own identity cache. Both already work because the source destination is constructed with the right root/config.

---

## 6. Skill change — `query` (`skills/query/SKILL.md`)

- **Step 2 (search):** the JSON now includes `source` on each result and a `warnings` array. If `warnings` is non-empty, tell the user in one short line which sources are unavailable, then continue answering from whatever did return.
- **Step 3 (read top results):** for each result run `pwiki get "<path>" --source="<source>"`. Cite by title / path.
- `allowed-tools` unchanged (`Bash(node:*)` already present).
- Step 2's `total === 0` branch is unchanged in wording but now means "nothing in the local wiki *or any source* covers that".

No other skill is touched (they are primary-only by §1.2).

---

## 7. Error handling

| code | when | exit | path |
|---|---|---|---|
| `config-invalid` | bad `sources` (unknown name, role overlap, non-string) | — | `validateConfig` → existing config error mapping |
| `unknown-source` | `get --source=<name>` names a non-source | 1 | new local check in `getPage` |
| `auth-failed` / `rate-limited` / `network-error` | source unreachable during `get` | 1 | existing `mapErrorToCode` (Confluence errors carry `.status`/`.code`) |
| (warning, not error) | source unreachable during `search` | 0 | captured in `warnings[]`, search still succeeds |

---

## 8. Testing (TDD)

- **config** (`config.test.ts`): valid `sources`; source name not in `destinations` → invalid; source name overlapping `primary` or a mirror → invalid; `fs` block with `path` validates; absent `sources` stays valid.
- **resolveDestination** (`destination-resolve.test.ts`): returns `sources` / `sourceNames`; sources constructed lazily; an `fs` source uses its `path` as root; a `confluence` source is constructed via the factory.
- **search union** (new test, FS primary + FS source fixture pointing at a second wiki dir): results tagged with the right `source`; `total` is the sum; `--limit` applied per source; a source that throws lands in `warnings` while primary results are still returned; a primary that throws is fatal.
- **get routing** (extend `cli-get.test.ts`): `--source=<fs-source>` reads from that source; unknown `--source` → exit 1 `unknown-source`; no flag → primary.
- **Confluence source**: covered with the existing `fake-confluence` fixture (search + get against a source block), mirroring `cli-get-confluence.test.ts`.

---

## 9. Documentation

- **README** "Multi-destination" section: document `sources` alongside `mirrors` (read-only inputs vs write-targets), and the FS `path` field. Note the shared-credentials limitation (§1.3).
- **`skills/_shared/templates/wiki-claude-md.template.md`**, CLI section: add `pwiki get <path> --source=<name>`, the `sources` config field, and that `search` results carry `source` + a `warnings` array.

---

## 10. Backwards compatibility

- Additive: new optional config field, new optional CLI flag, new optional result fields (`source`, `warnings`). No command renamed or removed.
- Configs without `sources` behave exactly as before; `search`/`get` with no sources configured are unchanged (empty source loop, `warnings: []`).
- Reader code for both backends is untouched.

Version bump: **4.10.0 → 4.11.0** (minor). Final tag fixed at push time per the repo's release rules.
