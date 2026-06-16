# Design: `pwiki init` — fix FS-primary + Confluence-mirror

**Date:** 2026-06-16
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` — CLI patch (`tools/pwiki.mjs` 3.2.1 → 3.2.2, `plugin.json` 4.8.1 → 4.8.2)
**Predecessor:** `2026-05-18-pwiki-v3-multi-destination-sync-design.md`

---

## 1. The bug

The `init` skill (`skills/init/SKILL.md`, step 2) documents that the topology
"FS primary + Confluence mirror" is created — after the FS scaffold completes —
by running:

```
pwiki init --mirror-confluence --mirror-site=<…> --mirror-space=<…> --mirror-parent=<…>
```

and promises the result `{ primary: "fs", mirrors: ["confluence-mirror"], … }`.
The v3 design doc §6.1 makes the same promise: the mirror flags "add a Confluence
mirror … if the primary is FS".

The implementation never built the FS-primary branch. Three barriers each abort
the documented call:

1. **Dispatch guard** (`pwiki.mjs`, `init` case): `if (!args.confluence) die('… only
   --confluence is supported here')`. The documented call has no `--confluence`,
   so it dies immediately.
2. **Unconditional primary args** (`initConfluence`): `--site/--space/--parent` are
   required for every invocation, even when there is no Confluence *primary* to
   resolve. The mirror-only call dies with `--site, --space, and --parent required`.
3. **Hardcoded primary** (`initConfluence`): `const config = { primary: 'confluence',
   … }` — there is no code path that produces `primary: 'fs'`.

The existing tests (`cli-init-confluence.test.ts`) only cover Confluence-primary
(plus optional FS/Confluence mirror), so the gap shipped unnoticed.

A related smell: `initConfluence` resolves a Confluence destination block twice
with near-identical code — once for the primary, once for the mirror.

## 2. Decision: fix `init` (variant A), not a new `dest add` command (variant B)

The fix makes `init` honour its own documented behaviour. We rejected the
alternative of a new `pwiki dest add` subcommand for this bug.

**Why A:**

- **The bug is in initialization.** The broken command runs inside the `init`
  skill at first-time setup, when `.pwiki.json` does not yet exist (the FS scaffold
  path does not write the config file). This is config creation from flags, not a
  mutation of an existing wiki.
- **A implements an already-written spec.** v3 design §6.1 explicitly anticipated
  `primary: "fs"` via `init`. The code simply hardcoded `primary: 'confluence'` and
  omitted the FS branch. A finishes the spec; it does not overload `init`.
- **Idempotency comes for free.** The output config is fully determined by the
  flags, and `ensureSubParent` is find-or-create (idempotent via the `pwiki-role`
  property). Re-running `init` with the same flags rewrites a byte-identical
  `.pwiki.json` and creates no duplicate sub-parents. No merge logic is required.

**Why not B (now):** a `dest add` command solves "add a destination to an
already-configured wiki later" — a real but *separate* need, documented in v3
§6.2 as a manual JSON edit. It is out of scope for this bug and would add a CLI
surface the v3 design does not have. It remains a valid future feature.

## 3. Implementation

### 3.1 `initConfluence` control flow

`initConfluence(args, _opts)` keeps its exported name and signature (tests import
it; it always involves Confluence in either the primary or mirror role). New flow:

```
primaryIsConfluence = !!args.confluence

if primaryIsConfluence:
  require --site/--space/--parent           # unchanged error: "--site, --space, and --parent required"
  destinations.confluence = resolveConfluenceBlock(transport, email, token, {site, space, parent})
  primaryName = 'confluence'
else:                                        # FS primary
  destinations.fs = { kind: 'fs' }           # site/space/parent NOT required
  primaryName = 'fs'

if args['mirror-fs']:
  destinations.fs = { kind: 'fs' }
  mirrors.push('fs')

if args['mirror-confluence']:
  require --mirror-site/--mirror-space/--mirror-parent   # unchanged error message
  destinations['confluence-mirror'] = resolveConfluenceBlock(transport, email, token,
                                          {site: mirror-site, space: mirror-space, parent: mirror-parent})
  mirrors.push('confluence-mirror')

config = { primary: primaryName, mirrors, destinations }
validateConfig(config); writeConfig(root, config)
emitJson({ ok: true, configPath, primary: primaryName, mirrors })
```

### 3.2 `resolveConfluenceBlock` helper

Extract the duplicated resolution into one helper:

```
resolveConfluenceBlock(transport, email, token, { site, space, parent })
  → { kind: 'confluence', siteUrl, spaceKey, spaceId, rootPageId, subParents }
```

It performs: space lookup (`GET /wiki/api/v2/spaces?keys=`), parent resolution
(numeric id verified, or CQL title lookup with ambiguity/not-found handling), and
`ensureSubParent` for each of `concept/person/source/query`. The
`config-invalid` emits for missing space / parent stay inside the helper. The
*presence* check for the three args stays at each call site so the two error
messages (primary vs mirror) remain exact.

### 3.3 Dispatch guard

```
if (command === 'init') {
  if (!args.confluence && !args['mirror-confluence'])
    die('use the /p-wiki:init skill for FS scaffolding; only --confluence is supported here', 1);
  await initConfluence(args);
}
```

Bare `init` (FS scaffolding) and `init --mirror-fs` alone (an FS mirror of an FS
primary is meaningless) still die and route through the skill.

### 3.4 Naming

The Confluence mirror destination is always named `confluence-mirror`, regardless
of primary. This matches `SKILL.md` step 2 and the promised config shape. The v3
design §6.1 parenthetical "(or `confluence` if the primary is FS)" is a
contradiction and is corrected to the uniform name.

### 3.5 Out of scope / accepted behavior

- **No merge.** `init` rewrites `.pwiki.json` from flags. Running
  `init --mirror-confluence …` over an existing Confluence-primary config would
  overwrite it with an FS-primary config. The `init` skill prevents this (step 4
  refuses if the wiki is already initialised); via raw CLI it is a deliberate
  re-initialization. Adding a destination to an existing config without
  overwriting is the `dest add` future feature (§2), not this fix.

## 4. Tests (TDD)

**`cli-init-confluence.test.ts`** (offline, `createFakeConfluence` transport):

- **FS-primary + Confluence-mirror:** `initConfluence({ 'mirror-confluence': true,
  'mirror-site', 'mirror-space', 'mirror-parent' }, { transport })` writes
  `primary: 'fs'`, `mirrors: ['confluence-mirror']`, `destinations.fs ===
  { kind: 'fs' }`, and a `confluence-mirror` block with non-empty
  `siteUrl/spaceKey/spaceId/rootPageId` and all four `subParents`. The config
  passes `validateConfig`.
- **Idempotency:** a second identical call writes the same config and creates no
  new pages (`fake.pageById.size` unchanged — `ensureSubParent` finds existing
  sub-parents).
- Existing Confluence-primary cases stay green (regression guard for the
  `resolveConfluenceBlock` extraction).

**`cli-entry.test.ts`** (subprocess; guard only, no transport injection):

- `init` with neither `--confluence` nor `--mirror-confluence` → exit 1, message
  "only --confluence is supported" (unchanged).
- `init --mirror-confluence` with no env vars → dies on the env-var check
  (`PWIKI_CONFLUENCE_EMAIL …`), **not** on the guard — proving barrier 1 is lifted.
- Update the version assertion `'3.2.1'` → `'3.2.2'`.

## 5. Documentation alignment

- `skills/init/SKILL.md` step 2 — command is already correct; confirm the promised
  shape names `confluence-mirror` and matches CLI output 1:1.
- v3 design §6.1 — fix the mirror-name contradiction; note the FS-primary `init`
  branch is now implemented.
- `skills/_shared/templates/wiki-claude-md.template.md` (Multi-destination) and
  `README.md` — ensure the FS-primary + Confluence-mirror example is present and
  accurate.

## 6. Versioning

Code↔docs desync fix; no new CLI command or flag (`--mirror-confluence` already
exists). Per root `.claude/CLAUDE.md` semver rules this is a **patch**:

- `tools/pwiki.mjs` `VERSION`: 3.2.1 → 3.2.2
- `.claude-plugin/plugin.json` `version`: 4.8.1 → 4.8.2

(The monorepo release tag is chosen later by the release process, not here.)
