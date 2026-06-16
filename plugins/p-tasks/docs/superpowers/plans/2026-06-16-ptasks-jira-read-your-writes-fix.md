# p-tasks Jira read-your-writes / transport fix — Implementation Plan

**Goal:** Make the p-tasks Jira backend work correctly from the CLI against live
Jira: read-your-writes resolution, working `init --primary=jira`, clean process
exit.

**Design:** `2026-06-16-ptasks-jira-read-your-writes-fix-design.md`

**Tech Stack:** Node ESM (`tools/`), Vitest, fake transports.

---

## Task 1 — Read-your-writes in `set`/`add`

- [x] `setCommand`: resolve the target via `readItem(id)` (not `listItems().find`).
- [x] `setCommand`: validate blockers by key (`readItem`) when absent from the search list; add the target to the cycle graph even if search hasn't indexed it.
- [x] `addCommand`: validate blockers by key when absent from the list; add them as cycle-graph nodes.
- [x] Thread `transport` through `add`/`set`/`next`/`summary` (matches `sync`; enables fake injection).

## Task 2 — `init --primary=jira` transport

- [x] Export `makeTransport` from `destination.mjs`.
- [x] Init jira probe defaults to `makeTransport()` when no transport injected (fixes "transport is not a function").

## Task 3 — Exit crash (libuv UV_HANDLE_CLOSING)

- [x] `makeTransport` → `node:https` with `keepAlive:false` (sockets close before `process.exit()`). Verified `init` exits 0 with empty stderr.
- [x] Same fix applied to p-wiki `makeRealTransport`.

## Task 4 — Tests

- [x] `cli-set-jira.test.ts`: set fresh key with empty search; item-not-found when truly absent; blocker validated by key under search lag. (All fail on the old `listItems` resolution.)
- [x] `cli-e2e.test.ts`: `vi.setConfig({ testTimeout: 30_000 })` to kill the parallel-load timeout flake.
- [x] `npx vitest run plugins/p-tasks` green (123 tests); full repo suite green parallel + serial.

## Task 5 — Version + live

- [x] CLI `VERSION` `0.1.0` → `0.1.1`; `.claude-plugin/plugin.json` `0.2.1` → `0.2.2`.
- [x] Live against `PMOCMT`: `jira-e2e` 6/6; CLI `init → add → set → next` exit 0; read-your-writes confirmed.
- [ ] Manual cleanup of test issues `PMOCMT-1..15` (token lacks Delete Issues permission).

## Task 6 — `add --blocked-by` creates the Jira link immediately

- [x] jira `createItem` creates a Blocks link for each `input.blockedBy` (sync still omits blockedBy here and reconciles links in its own pass).
- [x] Unit test (`jira-destination.test.ts`): createItem posts `/issueLink` with the right inward/outward keys.
- [x] Live: `add task --blocked-by B` creates a real link (raw-API verified); `next` excludes the blocked issue.

## Task 7 — `sync` to a Jira mirror is idempotent

- [x] `sync.mjs` `resolveExisting`: when a mapped key is known, fetch the mirror issue by key (read-your-writes) before re-creating — fixes the duplicate-every-run bug caused by JQL search lag.
- [x] `next`/`summary` over Jira data covered by `cli-next-summary-jira.test.ts`.
- [x] Unit test (`sync.test.ts`): a lagging-listItems mirror does not get a duplicate on re-sync.
- [x] Live: fs→jira mirror creates tasks/sub-tasks/links/status correctly; sync #2 `created:0`; edit → `updated:1`.
