# Contributing

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
