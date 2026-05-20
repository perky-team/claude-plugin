# Design: `p-tasks` plugin — task tracker with FS and Jira destinations

**Date:** 2026-05-20
**Status:** Drafted (brainstorming)
**Target:** new plugin in the `perky.team` marketplace, v0.1.0
**Sibling plugins (architectural reference):** `p-wiki` v3.0.0 (multi-destination sync), `p-flow` (workflow rules)

---

## 1. Goal

A Claude Code plugin that maintains a two-level task hierarchy (`task` → `sub-task`) with statuses `todo` / `in_progress` / `done` and blocker relationships. The data lives in one of two destinations — a local YAML file or Jira — and one destination can act as a one-way mirror of the other. All operations (create, status change, "what's next", "what's done") run through the same skill-per-operation surface that p-wiki established.

The plugin makes a Claude session in any repo capable of saying:

- "Add a task: refactor the auth module"
- "Mark sub-task `st-7` as done"
- "What should I work on next?"
- "Summarize what we've finished on `t-12`"
- "Sync everything to Jira"

…with a deterministic, file-backed reality on the FS side and a 1:1 mirror in Jira.

---

## 2. Architecture

### 2.1 Plugin layout

```
plugins/p-tasks/
├── .claude-plugin/
│   └── plugin.json                     ← name=p-tasks, version=0.1.0
├── README.md
├── skills/
│   ├── init/SKILL.md                   → /p-tasks:init
│   ├── add/SKILL.md                    → /p-tasks:add
│   ├── set/SKILL.md                    → /p-tasks:set
│   ├── next/SKILL.md                   → /p-tasks:next
│   ├── summary/SKILL.md                → /p-tasks:summary
│   ├── sync/SKILL.md                   → /p-tasks:sync
│   └── _shared/templates/              ← CLAUDE.md template, tasks.yml seed
└── tools/
    ├── ptasks.mjs                      ← CLI entry: parse argv, dispatch lib
    └── lib/
        ├── config.mjs                  ← read/write `.ptasks.json`, validate, defaults
        ├── schema.mjs                  ← statuses, item shapes, id prefixes
        ├── yaml.mjs                    ← (de)serialize tasks.yml
        ├── destination.mjs             ← resolveDestination(env) → {primary, mirrors}
        ├── destinations/
        │   ├── fs.mjs                  ← FS Destination impl
        │   └── jira.mjs                ← Jira Destination impl
        ├── sync.mjs                    ← orchestrator (passes 0..5)
        ├── next.mjs                    ← unblocked-item ranking
        ├── summary.mjs                 ← done-item rollups
        └── jira/
            ├── http.mjs                ← fetch wrapper, auth, retry, error mapping
            ├── issues.mjs              ← create/update/list issues, status transitions
            └── links.mjs               ← issue links of type "Blocks"
```

**Skill-per-operation:** each `SKILL.md` automatically becomes the `/p-tasks:<name>` slash command and is auto-activated by its `description` triggers. No separate `commands/` files.

**Per-plugin `tools/lib/`** — we **do not** share library code with `p-wiki`. Their domain (markdown pages + cross-links) and ours (structured YAML items) diverge enough that a shared abstraction would be brittle. The architectural pattern is copied wholesale; the code is independent.

### 2.2 Data layout in repo

```
docs/tasks/
├── tasks.yml          ← whole store: tasks + their sub-tasks
├── .ptasks.json       ← destinations config
└── CLAUDE.md          ← rules for Claude, auto-loads when working inside docs/tasks/
```

Plus `<repo>/.claude/rules/p-tasks.md` — a short global rule (~30 lines, no `paths:`) that loads every session and informs any Claude/skill that p-tasks exists in this repo.

**Repo root** resolves via `git rev-parse --show-toplevel`. Outside a git repo, the CLI falls back to CWD with a warning. Same pattern as p-wiki.

### 2.3 Data model — `tasks.yml`

```yaml
tasks:
  - id: t-1
    title: "Add user login"
    description: "OAuth flow with Google"
    status: in_progress           # todo | in_progress | done
    blockedBy: []                 # IDs of other tasks or sub-tasks
    jiraKey: PROJ-15              # optional, filled by sync when FS is primary + Jira is mirror
    subTasks:
      - id: st-1
        title: "Hash passwords with bcrypt"
        description: ""
        status: todo
        blockedBy: [st-2]
        jiraKey: PROJ-17
      - id: st-2
        title: "DB schema for users"
        description: ""
        status: done
        blockedBy: []
        jiraKey: PROJ-18
  - id: t-2
    title: "Wire up CI"
    description: ""
    status: todo
    blockedBy: [t-1]
    subTasks: []
```

**Invariants:**

- `id` is unique across the whole file (both `t-*` and `st-*` namespaces combined are unique).
- `t-*` identifies a top-level task; `st-*` identifies a sub-task. The prefix encodes the level.
- **Strict two-level hierarchy.** A sub-task's parent is always a task (`t-*`). Nesting `subTasks` under another sub-task is forbidden and rejected on `add` / `set` with `parent-not-found` (the `st-*` id "exists" but is not a valid parent kind). Validation enforces this on every write.
- `subTasks` always present (empty array if none) — uniform parsing.
- `blockedBy` always present (empty array if none).
- `description` is a short text (single-line or short paragraph). Long-form descriptions are out of scope for v0.1.0; a future `descriptionFile: <path>.md` field can carry them without breaking the schema.
- When FS is primary: `id` is a locally generated counter; `jiraKey` is optional mapping populated by sync.
- When Jira is primary: `id` *is* the Jira issue key (e.g. `PROJ-15`); the `jiraKey` field is omitted to avoid duplication.

**ID generation (FS primary).** For a new task: `max(N for id of form 't-N') + 1`, prefixed `t-`. For a new sub-task: same with `st-`. Empty file → starts at `t-1` / `st-1`. The counter is **derived from the file's contents on every create**, never stored separately — there is no `_meta.nextId` block. This works because v0.1.0 has no `delete` operation, so IDs are append-only and reuse is impossible.

**No `delete` in MVP.** None of the six required operations from the brief involve deletion. If a wrong item is created, the user can rename it or mark it `done`. A future delete will either re-introduce explicit counter metadata or move items to a `tombstones` block; not in scope here.

### 2.4 Config — `.ptasks.json`

```json
{
  "primary": "fs",
  "mirrors": [],
  "destinations": {
    "fs": { "kind": "fs" },
    "jira": {
      "kind": "jira",
      "siteUrl": "https://example.atlassian.net",
      "projectKey": "PROJ",
      "issueTypes": { "task": "Task", "subTask": "Sub-task" },
      "statusMap": { "todo": "To Do", "in_progress": "In Progress", "done": "Done" },
      "jql": "project = PROJ AND issuetype in (Task, Sub-task)"
    }
  }
}
```

**Field semantics** (mirroring p-wiki v3 §2.1):

- `primary` (required, string) — name keying into `destinations`. Every non-sync CLI command operates on `destinations[primary]`.
- `mirrors` (optional, array of strings) — zero or more names that receive a 1:1 copy of primary on every `ptasks sync`. Defaults to `[]`.
- `destinations` (required object) — map keyed by user-chosen name. Each entry has an explicit `kind` (`fs` | `jira`); other fields depend on kind. Multiple Jira destinations are valid (e.g. test instance + prod instance as mirrors of an FS primary). Multiple FS destinations are technically accepted but pointless — all of them would write to `<repoRoot>/docs/tasks/`. `ensureStructure` is idempotent across calls, so this is not an error, but `init` warns the user if asked to configure more than one FS destination.
- Per-Jira-destination fields:
  - `siteUrl`, `projectKey` — required.
  - `issueTypes.task` (default `"Task"`), `issueTypes.subTask` (default `"Sub-task"`) — names of the issue types this destination uses.
  - `statusMap` — maps internal status (`todo` / `in_progress` / `done`) to the Jira status name expected by this project's workflow. Defaults `{ "To Do", "In Progress", "Done" }`.
  - `jql` — JQL used when listing items from Jira (Jira-primary case). Default `"project = <projectKey> AND issuetype in (<task>, <subTask>)"`.

**Default if file is absent:** `{ primary: "fs", mirrors: [], destinations: { fs: { kind: "fs" } } }`.

**Credentials** are env-vars only, never on disk: `PTASKS_JIRA_EMAIL` and `PTASKS_JIRA_TOKEN`. Validated lazily — only checked when a Jira destination is actually contacted.

### 2.5 Destination interface

Both `fs.mjs` and `jira.mjs` implement:

```js
interface Destination {
  kind: 'fs' | 'jira'
  name: string                                                       // key in .ptasks.json

  // identity / read
  listItems(): Promise<Item[]>                                       // flat list, sub-tasks carry { parentId }
  readItem(id: string): Promise<Item>
  nextLocalId(prefix: 't' | 'st'): Promise<string>                   // implemented only by FS; Jira throws

  // write
  createItem(input: { type: 'task' | 'sub-task', parentId?: string, title, description?, status?, blockedBy? }): Promise<Item>
  updateItem(id, patch: { title?, description?, status?, blockedBy?, jiraKey? }): Promise<Item>

  // bootstrap
  ensureStructure(): Promise<void>                                   // FS: create tasks.yml; Jira: validate project/issue-types
}
```

`Item` shape (returned by `listItems` / `readItem` / `createItem` / `updateItem`):

```
{
  id: string                          // 't-12' or Jira key
  type: 'task' | 'sub-task'
  parentId?: string                   // present for sub-tasks
  title: string
  description: string
  status: 'todo' | 'in_progress' | 'done'
  blockedBy: string[]                 // ids on the same destination
  jiraKey?: string                    // present on FS items when mapped to Jira
}
```

`sync.mjs` is implemented entirely against this interface — it never reaches into FS file paths or Jira REST endpoints directly.

---

## 3. Skill workflows

All skills dispatch to the bundled CLI (`node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" <subcommand> ...`). The skill is responsible for collecting user input, calling CLI, and rendering the result conversationally. CLI returns structured JSON via `--json`; without `--json`, human-readable text.

### 3.1 `/p-tasks:init`

**Triggers:** "init p-tasks", "create task list", "setup task tracking", "start tracking tasks in this repo".
**Arguments:** none (interactive).

**Algorithm:**
1. Verify `node --version >= 18`. If not, instruct user to install/update Node and stop.
2. **Pre-flight: check if `docs/tasks/.ptasks.json` already exists.** If yes, refuse with `error.code = already-initialized` and instruct the user to edit `.ptasks.json` directly (or remove it before re-running `init`). This prevents accidental destruction of existing config and `tasks.yml`.
3. Ask: primary destination? `fs` (default) or `jira`.
4. If `jira`:
   - Verify `PTASKS_JIRA_EMAIL` and `PTASKS_JIRA_TOKEN`; if missing, link to https://id.atlassian.com/manage-profile/security/api-tokens and stop.
   - Prompt: `siteUrl` (e.g. `https://example.atlassian.net`).
   - Prompt: `projectKey` (e.g. `PROJ`).
   - Confirm/override `issueTypes` defaults.
   - Confirm/override `statusMap` defaults.
5. Ask: add a mirror? `none` (default) / `fs` / `jira`.
6. Invoke `ptasks init <flags>`. CLI writes `docs/tasks/.ptasks.json`, scaffolds empty `docs/tasks/tasks.yml` (if FS is in any destination), writes `docs/tasks/CLAUDE.md`, writes `.claude/rules/p-tasks.md`.

**CLI:** `ptasks init [--primary fs|jira] [--mirror fs|jira|none] [--site=...] [--project=...] [--task-type=...] [--sub-task-type=...]`.

### 3.2 `/p-tasks:add`

**Triggers:** "add task", "new sub-task", "добавь задачу", "создать таск".
**Arguments:** `<task | sub-task>`, title, optional description, optional `parent-id` for sub-task, optional blockedBy list.

**Algorithm:**
1. Ask for missing required fields (title; for sub-task — parent-id if not given).
2. Validate: parent-id exists **and is a task** (`t-*`, not `st-*` — see §2.3 invariant); all blockedBy ids exist; adding these blockers would not create a cycle.
3. Resolve next id (primary's `nextLocalId` for FS; Jira-issued key for Jira).
4. Write to primary. Render the created item.

**Cycle check:** before writing blockers, DFS the `blockedBy` graph including the to-be-added edges. Reject with `cycle-detected` on first back-edge.

**CLI:**
```
ptasks add task --title "..." [--description "..."] [--blocked-by t-5,st-3] [--json]
ptasks add sub-task <parent-id> --title "..." [--description "..."] [--blocked-by ...] [--json]
```

### 3.3 `/p-tasks:set`

**Triggers:** "set status", "mark done", "mark in progress", "add blocker", "unblock", "rename task".
**Arguments:** `<id>`, then any combination of:

- `--status todo|in_progress|done`
- `--title "..."` / `--description "..."`
- `--blocked-by id1,id2,...` — full replacement of the list
- `--add-blocker <id>` / `--remove-blocker <id>` — incremental
- `--json`

**Algorithm:**
1. Read primary, locate item by id (`item-not-found` if missing).
2. For blocker changes: validate all referenced ids exist (`blocker-not-found`), check no cycle (`cycle-detected`).
3. For `--status`: validate against enum (`invalid-status`).
4. `updateItem(id, patch)` on primary.

Multiple flags in one invocation apply atomically (single write).

### 3.4 `/p-tasks:next`

**Triggers:** "next task", "what should I work on", "что делать дальше".
**Arguments:** optional `--all`, optional `--json`.

**Algorithm:**
1. `listItems()` on primary.
2. **Filter** candidates: `status != done` AND every id in `blockedBy` resolves to an existing item with `status == done`. A non-existent blocker id is **not** silently treated as satisfied — the candidate is excluded and a warning is emitted to stderr.
3. **Sort** by the tuple `(statusRank, parentInProgressRank, id)`, lowest first:
   - `statusRank`: `0` if `status == in_progress`, `1` if `status == todo`.
   - `parentInProgressRank`: `0` if the item is a sub-task whose parent task has `status == in_progress`, `1` otherwise.
   - `id`: ascending by the numeric suffix `N` of the `<prefix>-N` id, scoped within the same prefix. Across prefixes the order is `t-*` before `st-*` (top-level surfaces before children) — purely a tie-break, not a semantic preference. This equals creation order in our scheme.

   Rationale: prefer continuing in-progress work over opening new work; within a status tier, prefer finishing sub-tasks whose parent task is already in flight.
4. Without `--all`: return top-1 only. With `--all`: return the whole ranked list.

### 3.5 `/p-tasks:summary`

**Triggers:** "summary", "what's done", "what did we ship", "саммари сделанного".
**Arguments:** optional `<task-id>`, optional `--json`.

**Algorithm:**
- Without `<task-id>`: list top-level tasks with `status == done`.
- With `<task-id>`: list sub-tasks of that task with `status == done`. Error `item-not-found` if the task doesn't exist.
- Fields in output: `id`, `title`, `description` (omitted if empty). Sort by id (creation order).

The skill takes the structured output and produces a natural-language rollup for the user. The CLI itself never generates prose.

### 3.6 `/p-tasks:sync`

**Triggers:** "sync tasks", "push to jira", "pull from jira", "синхронизируй задачи".
**Arguments:** none.

**Algorithm:** delegates to `sync.mjs` (see §4). Renders the per-mirror counters.

### 3.7 CLI conventions

- Every command supports `--json`. Without it, output is human-readable text on stdout.
- Errors: exit code != 0. Human message on stderr. With `--json`, an `{"error": {"code", "message", ...}}` object on stdout.
- Error code taxonomy: §5.1.
- Common flags: `--json`, `--config <path>` (override `.ptasks.json` location, mostly for tests), `--verbose`.

---

## 4. Sync orchestration

`ptasks sync` is the only command that crosses destination boundaries. It is **one-way** — `primary` → each `mirror` — and **idempotent**: re-running on the same state is a no-op (modulo network/version drift).

### 4.1 Passes (per mirror)

```
Pass 0  mirror.ensureStructure()
Pass 1  srcItems = primary.listItems()                  // includes parent meta on sub-tasks
Pass 2  dstItems = mirror.listItems()
        dstIndex = Map<mappedKey, dstItem>
Pass 3a Upsert top-level tasks (no blockers yet, no sub-task references)
Pass 3b Upsert sub-tasks with parent reference
Pass 4  Reconcile blocker links (delete extras on mirror, add missing — see §4.3)
Pass 5  Write back mapping keys to primary (jiraKey field) where created
```

**Why split 3a/3b:** Jira requires a `parent.key` reference that already exists when creating a sub-task issue. On FS-mirror the split is harmless overhead.

**Why pass 4 is separate:** blockers may reference items that have not yet been created at the moment their source item is processed. Create-all-then-link is the same two-pass idea p-wiki uses for cross-links.

**Pass 5 is the only write into primary** during sync. It records the mapping (e.g. the Jira key assigned to a newly created issue) so the next sync skips creation and goes straight to update.

### 4.1.1 Multiple mirrors — error isolation

`sync` iterates mirrors sequentially. A failure on one mirror (network, auth, transition mismatch) is recorded in that mirror's counters object and **does not abort** sync for the next mirror. The CLI's overall exit code is non-zero if any mirror reported a non-empty `errors` field. The returned shape is an array of per-mirror counter objects (§4.6).

### 4.2 Identity and mapping

How sync decides "this src item corresponds to this dst item":

| primary → mirror | match strategy                                                                 |
|------------------|--------------------------------------------------------------------------------|
| FS → Jira        | `srcItem.jiraKey` is the dst id. If absent → no match → create.                |
| Jira → FS        | `srcItem.id` (which is the Jira key) is the FS id. If absent on FS → create.   |

This asymmetry is deliberate: when FS is primary, the FS id (`t-N`) is the user-facing identity, and `jiraKey` is just routing metadata. When Jira is primary, the Jira key *is* the identity and there is no second namespace.

### 4.3 Field translation

| ptasks field        | Jira representation                                                            |
|---------------------|--------------------------------------------------------------------------------|
| `title`             | `summary`                                                                      |
| `description`       | `description` field as ADF (markdown → ADF conversion in `jira/issues.mjs`)    |
| `status`            | via **status transition** — GET `/issue/{key}/transitions`, find a transition whose target name matches `statusMap[status]`, POST it. Direct status assignment is not allowed by Jira API. **Single-hop only**: the endpoint returns only transitions valid from the issue's *current* state. If the workflow requires going through an intermediate state (e.g. `In Progress → Code Review → Done`) and no direct `In Progress → Done` exists, sync emits `transition-not-found` and skips this item. Multi-hop traversal is out of scope for v0.1.0. |
| `blockedBy: [...]`  | issue links of type `Blocks` — **reconciled** on each sync: pass 4 computes the expected set of blocker links (from primary) for each item, GETs the existing set from the mirror, DELETEs links in (existing − expected), POSTs links in (expected − existing). This is **link-level reconciliation**, separate from §4.5's "no item deletion" rule. Links are lightweight, frequently changing relationships; items are not. |
| `subTasks[...]`     | `parent.key` set on sub-task issue at create time (Jira's inherent relation). The parent is never changed after create — a sub-task moving between tasks is out of scope for MVP. |

If the Jira workflow does not expose the needed transition (single-hop), the item is skipped with a warning carrying code `transition-not-found`. Sync continues with the next item.

### 4.4 Idempotency and partial failures

- Every write is upsert keyed on identity (§4.2). Repeated runs converge to no-ops.
- A failure mid-sync leaves whatever was written intact, including `jiraKey`s already persisted back to primary. The next run continues from there.
- Network errors / 5xx / 429 — retried with exponential backoff inside `jira/http.mjs`. On exhaustion the CLI exits with `network-error` or `rate-limited`.
- Jira 409 (version conflict on update) — refetch current version, recompute payload, retry once. Second failure → `version-conflict`.

### 4.5 What sync does not do (MVP)

- **No deletion on mirror.** Items present on a mirror but absent from primary stay untouched. (No `--prune` flag.) This is consistent with §2.3 — primary itself has no delete.
- **No two-way sync, no conflict resolution.** Mirrors are write-only sinks for content; the only reverse write is the `jiraKey` mapping.
- **No attachments, comments, or history.**

### 4.6 Output

CLI returns an array — one entry per mirror — so multi-mirror sync results are visible even if one entry has errors. `warnings` is a list of structured records; its length is the warning count (no redundant scalar count field).

```json
[
  {
    "mirror": "jira",
    "kind": "jira",
    "created": 3,
    "updated": 5,
    "linksAdded": 2,
    "linksRemoved": 1,
    "warnings": [
      { "code": "transition-not-found", "id": "t-7", "from": "todo", "to": "Done (PROJ workflow)" }
    ],
    "errors": []
  }
]
```

Per-mirror `errors` is non-empty only if sync aborted for that mirror (auth, network exhaustion, primary-side cycle). Exit code is non-zero if any mirror reports non-empty `errors`.

Without `--json` — a human summary with the same numbers per mirror.

---

## 5. Error handling

### 5.1 Error code taxonomy

| code                     | when                                                              |
|--------------------------|-------------------------------------------------------------------|
| `config-invalid`         | `.ptasks.json` unreadable; unknown fields; missing required ones  |
| `already-initialized`    | `init` invoked but `docs/tasks/.ptasks.json` already exists       |
| `auth-failed`            | Jira 401/403; missing env-vars                                    |
| `item-not-found`         | id not found in primary on `set` / `summary`                      |
| `parent-not-found`       | parent-id of a new sub-task doesn't exist                         |
| `cycle-detected`         | adding the blocker would create a cycle                           |
| `blocker-not-found`      | id in `blockedBy` doesn't exist                                   |
| `invalid-status`         | `status` outside `todo` / `in_progress` / `done`                  |
| `transition-not-found`   | Jira workflow has no transition matching the mapped target status |
| `version-conflict`       | Jira 409 after retry                                              |
| `rate-limited`           | Jira 429 after retry                                              |
| `network-error`          | timeout / ECONNRESET / 5xx after retry                            |
| `internal`               | bug — uncovered cases                                             |

HTTP-status-to-code mapping is centralised in `lib/jira/http.mjs` (analogous to `pwiki/confluence/http.mjs#mapErrorToCode`).

### 5.2 Validation timing

- **Config:** `config.mjs#readConfig` runs on every CLI invocation. Fails fast with `config-invalid` and a message that names the offending field.
- **Item shape:** `schema.mjs#validateItem` — warning on read (let users work with a partially-broken file), hard fail on write.
- **Cycles:**
  - On `add` and `set --add-blocker` / `set --blocked-by` — DFS over the to-be-state of the `blockedBy` graph in primary. Reject with `cycle-detected`.
  - **For Jira-primary**, `sync` reads the issue graph including manually-created `Blocks` links, which may form a cycle Jira itself doesn't reject. After Pass 1 (`primary.listItems()`), the orchestrator runs a cycle check on the assembled `blockedBy` graph; on detection, sync aborts with `cycle-detected` and the offending Jira keys before any writes to mirrors. For FS-primary the check is skipped — primary is clean by construction.
- **Jira env-vars:** checked only when a Jira destination is actually contacted (`init --jira ...` or any `sync` involving a Jira destination). Pure FS workflows do not require Jira credentials.

---

## 6. Testing

Stack: **Vitest** (already in the repo — see `vitest.config.ts`, `package.json`). Tests live in `plugins/p-tasks/tools/__tests__/`, mirroring `plugins/p-wiki/tools/__tests__/`.

**Layers:**

1. **Unit tests on pure lib functions.**
   - `schema.mjs` — id prefix parsing, status enum, item shape validation.
   - `next.mjs` — fixture-based assertions on the ranking output.
   - `summary.mjs` — done filter, parent scoping.
   - `yaml.mjs` — round-trip (de)serialize.

2. **Unit tests on FS destination.**
   - `createItem` assigns next id correctly across empty / populated / gap-after-no-delete states.
   - `updateItem` patches only the named fields.
   - `listItems` flattens correctly with `parentId` meta on sub-tasks.

3. **Integration tests on Jira destination with a fake transport.**
   - `createJiraDestination({transport})` accepts an injected fetch double, similar to `makeRealTransport` in pwiki.
   - Covers: create Task / create Sub-task with parent.key / link Blocks / status transitions / 409 retry / mapping errors.

4. **Integration tests on `sync.mjs`.**
   - Two fake destinations (FS on a temp dir; Jira on a fake transport).
   - Scenarios:
     - empty mirror → create everything;
     - rerun on same state → no-op (no writes other than possibly mapping persistence);
     - add blocker on primary → link POSTed on mirror;
     - **remove blocker on primary → link DELETEd on mirror** (link reconciliation);
     - **extra link present on mirror only → DELETEd** (link reconciliation);
     - transition not exposed by Jira workflow → `transition-not-found` warning recorded, sync continues to next item;
     - **mirror A network failure, mirror B healthy → A reports error, B completes** (multi-mirror isolation);
     - **Jira-primary with cyclic Blocks links → sync aborts with `cycle-detected` before any mirror writes**.

5. **Cycle detection on writes.**
   - Chain `t-1 → t-2 → t-3`; attempt `ptasks set t-3 --add-blocker t-1` → reject with `cycle-detected`.

6. **Two-level hierarchy enforcement.**
   - `ptasks add sub-task st-1 --title "..."` → reject with `parent-not-found` (parent must be a task).

7. **Init guard.**
   - `ptasks init ...` when `docs/tasks/.ptasks.json` already exists → reject with `already-initialized`.

CI wires the existing `npm test` (Vitest) to include `plugins/p-tasks/tools/__tests__/**`.

**Out of scope (MVP):** E2E tests against a real Jira instance, property-based / fuzz testing, concurrent-write/file-lock tests on FS.

---

## 7. Non-goals (MVP, restated)

- `ptasks delete`. Item lifecycle is create + update only.
- Two-way sync, conflict resolution, `lastSyncedAt` per field.
- Custom priorities, tags, assignees, due dates.
- `--prune` on sync (deletion of mirror items absent from primary).
- Multi-path FS instances (all FS destinations point at `<repoRoot>/docs/tasks/`).
- Attachments, comments, page/issue history.
- Long-form descriptions stored separately from `tasks.yml`.
- E2E tests against live Jira.
