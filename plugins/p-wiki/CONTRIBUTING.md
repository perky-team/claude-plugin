# Contributing

## Never use the global `fetch` in the CLI

`makeRealTransport()` deliberately uses `node:https` with a per-request agent set to
`keepAlive: false`. Do not "simplify" it to `fetch`.

The CLI calls `process.exit()` as soon as a command finishes. `fetch` is undici, which
holds a socket pool open after the response resolves, and exiting into that teardown
aborts the process on Windows with a libuv assertion
(`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`) and exit code 3221226505 —
after the command already did its work and printed correct output. Two requests in one
run are enough; `sync` against Confluence makes many. The CLI suites cannot catch it:
they inject a fake transport, so no real socket is open at exit.

If you ever do need `fetch` here, drop `process.exit()` first: set `process.exitCode`
and return, the way `p-chat` does. `tests/cli-exit-safety.test.ts` enforces that a
plugin picks one of the two, never both.

## Running E2E tests against real Confluence

The Confluence E2E suite is gated by `PWIKI_E2E_CONFLUENCE=1` and skipped by default in CI and `npm test`. Before tagging a new minor or major release of p-wiki, run E2E locally against a **dedicated test space** — never against a real working space.

### Setup

1. Create a Confluence Cloud space (e.g. `PWIKITEST`) you can freely create/delete pages in.
2. Create a parent page in that space (e.g. "pwiki E2E root"). Note its numeric page ID from the URL.
3. Generate an Atlassian API token at https://id.atlassian.com/manage-profile/security/api-tokens.

### Run

```bash
PWIKI_CONFLUENCE_EMAIL=you@example.com \
PWIKI_CONFLUENCE_TOKEN=<token> \
PWIKI_E2E_CONFLUENCE=1 \
PWIKI_E2E_SITE_URL=https://your-org.atlassian.net \
PWIKI_E2E_SPACE_KEY=PWIKITEST \
PWIKI_E2E_ROOT_PAGE_ID=<numericId> \
npm test plugins/p-wiki/tools/__tests__/confluence-e2e.test.ts
```

The suite creates pages, exercises every CLI command, then deletes everything it created. If the test fails mid-run, pages may be left behind — clean them up manually before re-running.

### What CI runs

CI runs `npm test` without the gating envs, so only unit + contract tests execute. Real-Confluence E2E is local-only.
