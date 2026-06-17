---
name: sync
description: |
  Sync the wiki's primary destination to every configured mirror (one-way primary → mirrors, idempotent). Use when the user says "sync wiki", "sync mirrors", "publish wiki", "push to confluence", "publish to confluence", "refresh the backup", or "синхронизировать зеркало".
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(test:*) Bash(node:*) Read
---

# /p-wiki:sync

You are running a one-way mirror sync. This is a **thin wrapper** over the bundled CLI —
all sync logic lives in `pwiki sync`. Do NOT reimplement any of it here; only run the
CLI and report what it did.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists.
If it does not, stop: "Not inside a p-wiki repo — run `/p-wiki:init` first."

## Step 2 — Read the config and decide whether there's anything to sync

Read `<root>/docs/wiki/.pwiki.json`.

- If the file is **absent**, the wiki is FS-only with no mirrors (the v1/default shape).
- If `mirrors` is **missing or empty**, there is nothing to sync.

In either case, stop with a friendly note (not an error):

> This wiki has no mirrors configured, so there's nothing to sync — `sync` copies the
> primary destination to its mirrors. Add a mirror in `docs/wiki/.pwiki.json` (and run
> `/p-wiki:init` again if you'd rather be prompted), then re-run `/p-wiki:sync`.

## Step 3 — Check Confluence credentials if needed

From the config, collect the destinations sync will touch: `primary` plus every name in
`mirrors`. For each, look up `destinations[<name>].kind`.

If **any** of those is `"confluence"`, verify both env vars are set:

- `PWIKI_CONFLUENCE_EMAIL`
- `PWIKI_CONFLUENCE_TOKEN`

(Check with `test -n "$PWIKI_CONFLUENCE_EMAIL"` / `test -n "$PWIKI_CONFLUENCE_TOKEN"`.)

If either is missing, stop and tell the user to create an API token at
<https://id.atlassian.com/manage-profile/security/api-tokens> and export both vars, then
re-run. Do not run the sync.

## Step 4 — Tell the user what's about to happen, then run

Before running, print one short notice (no `y/N` prompt — sync is routine and
idempotent, just make the semantics visible):

> Syncing primary `<primaryName>` → mirror(s) `<mirror names>`. This is **one-way**:
> manual edits in the mirror(s) are **overwritten** and mirror-only pages are
> **deleted** (true mirror). Raw sources are not touched.

Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" sync --format=json
```

## Step 5 — Render the result

Parse the JSON `{ ok, mirrors: [...] }`. For each entry in `mirrors`, report:

- mirror **name**
- **written** / **rewritten** / **deleted** page counts
- **warnings** (if > 0 — these are unresolved cross-link targets; mention `/p-wiki:lint`
  will surface the broken links on the mirror)
- **elapsed** time (`elapsedMs` → seconds)

If a mirror entry has an `error` object, report its `code` and `message` for that mirror
and note the other mirrors' outcomes still apply. Finish with a one-line total
(e.g. "2 mirrors synced, 47 pages written, 2 deleted").

## Error handling

If `pwiki sync` exits non-zero, parse the JSON `error.code` (top-level) or per-mirror
`mirrors[].error.code` and surface it — never swallow it:

| error.code | What to say to the user |
|---|---|
| `auth-failed` | "Check PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN; verify the token grants access to the space." |
| `config-invalid` | "`.pwiki.json` is invalid (e.g. `primary`/mirror name not in `destinations`, or a destination missing `kind`) — fix it or re-run `/p-wiki:init`." |
| `rate-limited` | "Confluence rate-limited; retry in a few minutes." |
| `network-error` | "Confluence is unavailable; retry later." |
| `version-conflict` | "A page was modified concurrently; just re-run `/p-wiki:sync`." |
| `internal` | "Internal CLI error — file an issue against p-wiki." |

Sync is **idempotent**: a partial failure leaves each mirror well-formed but possibly
incomplete, and re-running `/p-wiki:sync` resumes cleanly. Tell the user this whenever a
mirror failed.
