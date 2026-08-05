# Give TypeScript call sites a caller — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index a function passed as a call argument as a definition, so a call
written inside a test callback has a caller instead of `outside any indexed symbol`.

**Architecture:** One new capture line in `ts.scm` and `js.scm` grabs the
`arrow_function` / `function_expression` / `generator_function` sitting in an
`arguments` list. The driver then drops any such definition that a *named*
definition encloses, and names the survivors after the call beside them
(`it('case', …)` → `it:case`). No resolver change: these definitions can never be
the *target* of a call, because no identifier can hold a `:` or a `@`.

**Tech Stack:** JavaScript (ESM), tree-sitter via web-tree-sitter (WASM), vitest,
node:sqlite.

## Global Constraints

- Node 24+ for the test suite (`node:sqlite` `immutable=1` is honoured there, not
  on Node 22). p-graph's own shipped floor stays Node 22.5.
- The work is done on Windows, so the e2e suites MUST also run under WSL before
  the work counts as verified, and BOTH platforms' numbers get reported.
- No Claude attribution in commit messages.
- Precision work is closed. Do not change any resolver pass, any guard, or any
  `field_types` rule. If a precision number moves, that is a defect in this work.
- Every tree-sitter pattern must be verified against the vendored grammar before
  it is committed: an invalid pattern does not fail to match, it takes the whole
  query file down.

## Facts already measured, do not re-derive

Verified before this plan was written:

| Fact | Value |
|---|---|
| The pattern that captures the callback itself | `(call_expression arguments: (arguments [(arrow_function) (function_expression) (generator_function)] @definition.function))` |
| It compiles against | `typescript`, `tsx`, `javascript` — and both whole `.scm` files still compile with it appended |
| The handoff's shape `… (arguments [(arrow_function) (function_expression)])) @definition.function` | compiles, but captures the **call**, not the callback — wrong span |
| This repo today | 20,018 / 28,216 call sites have no caller (71%); TS alone 19,209 / 20,509 (94%) |
| Call sites the rule would newly attribute | 18,391 |
| Of those, the caller carries a real label (`it:case`) | 17,061 (93%) |
| The 1,330 with no label, by callee | `beforeEach` 794, `afterEach` 189, `expect` 99, unnamed 50, `beforeAll` 38, rest ~160 |
| New definition nodes | ~2,680 |

**A refinement was measured and rejected.** "Prefer the innermost callback that
carries a string label" would move 464 call sites (2.5%) from `expect@16` to
`it:<test name>` — but it would also hide all 1,031 `beforeEach` / `afterEach` /
`beforeAll` / `afterAll` attributions behind `describe:<suite>`, and a call in the
setup hook is a different fact from a call in a test. The handoff's plain rule wins.

---

### Task 1: Index a call-argument function that no named definition encloses

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/lang/ts.scm` (append one capture)
- Modify: `plugins/p-graph/tools/lib/parse/lang/js.scm` (append the same capture)
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` — a naming helper next to
  `selfCallOwner` (~line 674), the `for (const d of defCaps)` loop (~line 696),
  and a filter after the `KIND_SPECIFICITY` dedup (~line 757)
- Test: `plugins/p-graph/tools/__tests__/ts-callback-defs.test.ts` (create)

**Interfaces:**
- Consumes: `within(inner, outer)`, `innermostFirst`, `capSignature`, `nodeId` —
  all already in `driver.mjs`.
- Produces: `CALLBACK_DEF_TYPES` (a `Set` of the three node type strings) and
  `callbackDefName(cb)` → `string`, both module-private to `driver.mjs`. Definitions
  carry a new boolean field `isCallback`, used only inside `extract()`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/ts-callback-defs.test.ts`. Note what
`store.callers` returns: the caller NODE's columns (`s.*`, grouped by `s.id`), so
assert on `qname` / `name`, never on a call-site line — there is no such column.

The file as committed carries nine tests. It is the source of truth; the shape is:

| # | Test | Asserts | RED before the change? |
|---|---|---|---|
| 1 | names a call in a test callback after the test | `callers('target')` qnames = `['describe:suite.it:case', 'named']` — the second half is the TRAP guard: an inline `xs.map(x => …)` inside `named` must not become the caller | yes |
| 2 | attributes to the innermost callback | `['describe:suite', 'describe:suite.it:case']` | yes |
| 3 | does not borrow the name of a definition written inside it | `['it:case.helper']`, not `helper.helper` | yes |
| 4 | falls back to the line when the call passes no string | `names` = `['beforeEach@2']` | yes |
| 5 | names a callback passed to the result of a call | `it.runIf(cond)('case', cb)` -> `['runIf:case']` | yes |
| 6 | keeps a named definition as the caller of a callback inside it | `['A.m', 'f']` — a class method and a `const` arrow | no, guards the trap |
| 7 | does the same in JavaScript | a `.mjs` file -> `['describe:suite.it:case']` | yes |
| 8 | never becomes the target of a call | `callees('it:case')` = `['helper']`, `callers('helper')` = `['it:case']` | yes |
| 9 | flattens a multi-line template literal | `['it:a name over two lines']` | yes |

Every test writes its fixture with `write(rel, src)`, indexes with
`indexFull({ root: dir, store, ignorePatterns: [] })` into an in-memory store, and
compares a sorted list — the same shape as `lexical-scope.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-callback-defs.test.ts`

Measured: 8 failed, 1 passed. Every test whose expectation names a callback fails
because the callback is not a definition, so `callers` returns fewer rows (test 3
returns `[]` — `helper`'s caller is missing too). Test 6 PASSES already: it guards
the trap, which today's code gets right.

- [ ] **Step 3: Add the capture to both grammars**

Append to `plugins/p-graph/tools/lib/parse/lang/ts.scm`:

```scheme
;; A function passed as a call ARGUMENT. It is not a declaration, so nothing used
;; to name it and every call inside it had no caller — and in TypeScript that is
;; where nearly all test code lives (`describe('x', () => …)`, `it('y', async () =>
;; …)`). 94% of this repo's own TypeScript call sites had no caller before this.
;;
;; The capture sits on the FUNCTION, not on the enclosing call: the definition's
;; span has to be the callback's body, or a call written after the callback would
;; look like it belongs to it. The driver drops any of these that a NAMED
;; definition encloses — see CALLBACK_DEF_TYPES there for why that matters — and
;; names the survivors after the call beside them.
(call_expression arguments: (arguments [(arrow_function) (function_expression) (generator_function)] @definition.function))
```

Append the identical block to `plugins/p-graph/tools/lib/parse/lang/js.scm`
(all three node types exist in the `javascript` grammar too — verified).

- [ ] **Step 4: Add the naming helper to the driver**

In `plugins/p-graph/tools/lib/parse/driver.mjs`, immediately after
`selfCallOwner` (ends ~line 674), insert:

```js
// The node types the "function passed as a call argument" capture can produce.
// They are only ever definitions in TS/JS, and only through that one capture, so
// the node type is what tells a callback definition apart from every other one.
//
// WHY THEY ARE NOT ALL INDEXED. An inline `xs.map(x => target() + x)` written
// inside a named function is ALREADY attributed to that function, which is both
// right and useful. Indexing every call-argument function would replace that
// caller with an anonymous arrow, and `impact` would stop there — nothing calls
// an arrow that is passed as a value. So a callback is indexed only when no
// named definition encloses it. A callback inside another callback stays: `it`
// inside `describe` should attribute to `it`, and the innermost-parent pick does
// that for free once both are definitions.
const CALLBACK_DEF_TYPES = new Set(['arrow_function', 'function_expression', 'generator_function']);

// The name a call-argument function goes by. It has none of its own, but the call
// beside it usually carries a string: `it('case', …)` -> `it:case`, which reads as
// the test's name in `callers` output, which is what a human wants to see. With no
// string first argument the line is the only thing separating two callbacks passed
// to the same function, so use it: `beforeEach@42`.
//
// Neither shape can collide with an identifier, so these definitions can never be
// the target of a call and no resolver pass had to change. The string is capped
// and its whitespace flattened: a test name can be a multi-line template literal,
// and a newline inside a qname would break one line of `callers` output into two.
function callbackDefName(cb) {
  const args = cb.parent;                       // (arguments …)
  const call = args?.parent;                    // (call_expression …)
  let fn = call?.childForFieldName?.('function');
  // `it.runIf(cond)('case', …)` calls the RESULT of a call, so the name of the
  // thing being called has to be read one level in.
  while (fn?.type === 'call_expression') fn = fn.childForFieldName?.('function');
  const callee = fn?.type === 'identifier' ? fn.text
    : fn?.type === 'member_expression' ? (fn.childForFieldName?.('property')?.text ?? null)
      : null;
  const first = args?.namedChild?.(0);
  const label = first && (first.type === 'string' || first.type === 'template_string')
    ? first.text.slice(1, -1).replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
  const base = callee ?? 'callback';
  return label ? `${base}:${label}` : `${base}@${cb.startPosition.row + 1}`;
}
```

- [ ] **Step 5: Name the callback definitions in the def loop**

In the `for (const d of defCaps)` loop, right before the `const nameCap = …`
statement (~line 723), insert:

```js
    // A callback has no name of its own, and the outermost `@name` capture inside
    // its span belongs to something else — a nested `function helper()` would
    // otherwise name the callback `helper` and collide with the real one. So the
    // name is read from the call beside it, and nameCap is skipped.
    const isCallback = CALLBACK_DEF_TYPES.has(d.node?.type ?? '');
    const ownName = isCallback ? callbackDefName(d.node) : null;
```

Then change the `nameCap` statement and the `defs.push` to use it:

```js
    const nameCap = (localPath || ownName) ? null : nameCaps
      .filter((n) => within(n, d))
      .sort((a, b) => (a.startLine - b.startLine) || (a.startCol - b.startCol))[0];
```

```js
    defs.push({
      kind, localPath, isCallback,
      name: localPath ? localPath.slice(localPath.lastIndexOf('.') + 1)
        : (ownName ?? nameCap?.text ?? '(anon)'),
      startLine: d.startLine, endLine: d.endLine,
      startCol: d.startCol, endCol: d.endCol,
      signature: capSignature(source.split('\n')[d.startLine - 1]?.trim() ?? ''),
      node: d.node, // kept for containment checks below; never copied into `nodes`
    });
```

- [ ] **Step 6: Drop callbacks that a named definition encloses**

In `driver.mjs`, right after the `KIND_SPECIFICITY` block replaces `defs`
(after `defs.push(...dedupedDefs);`, ~line 757), insert:

```js
  // Only the callbacks no named definition encloses — see CALLBACK_DEF_TYPES.
  // Runs after the span dedup so "encloses" is asked of one definition per span.
  if (defs.some((d) => d.isCallback)) {
    const kept = defs.filter((d) => !d.isCallback ||
      !defs.some((p) => !p.isCallback && within(d, p)));
    defs.length = 0;
    defs.push(...kept);
  }
```

- [ ] **Step 7: Run the new test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-callback-defs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 8: Run the whole p-graph suite**

Run: `npx vitest run plugins/p-graph`

Expected: PASS. Two existing suites are the ones at risk and must be read, not
just counted: `ts-var-types.test.ts` and `member-call-owner.test.ts` — a callback
becoming a definition changes the `owner.id` inside every `#var:` and `#param`
key written for names bound in it. Writer and reader build that key from the same
`defs` list, so the change should be invisible. If a test there fails, the key is
being built from different `defs` on the two sides and that is a real defect.

If any existing test's expectation has to change, STOP and record why in
`.superpowers/sdd/progress.md` before changing it.

- [ ] **Step 9: Mutation-test the trap guard**

The point of the whole rule is the filter in Step 6. Prove the test suite catches
its removal: delete the `if (defs.some((d) => d.isCallback)) { … }` block, run
`npx vitest run plugins/p-graph/tools/__tests__/ts-callback-defs.test.ts`, and
confirm the first test and the sixth FAIL (`map@3` / `forEach@2` instead of
`named` / `A.m`). Restore the block and confirm green again.

- [ ] **Step 10: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/lang/ts.scm plugins/p-graph/tools/lib/parse/lang/js.scm plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/ts-callback-defs.test.ts
git commit -m "feat(p-graph): give a call-argument function a name, so a call inside a test has a caller"
```

---

### Task 2: Measure, on this repo and on the pinned clones

**Files:**
- Create: `plugins/p-graph/docs/superpowers/plans/2026-08-05-p-graph-ts-callback-defs-results.md`
- Modify: `.superpowers/sdd/progress.md` (append the ledger entry)

**Interfaces:**
- Consumes: the shipped CLI at `plugins/p-graph/tools/pgraph.mjs`, and
  `plugins/p-graph/scripts/measure.mjs --no-clone`.
- Produces: nothing code depends on.

- [ ] **Step 1: Record the "before" numbers for this repo**

Already measured on `main` at 9aea17f, with the shipped code:

```
status: schema 8 - 1540 nodes - 29667 edges - 379 files - fts true - drift 0
        - unattributed calls 23576/28216
call sites with no caller  20018 / 28216  (71%)   TS 19209/20509   JS 809/7707
resolved                    4640           guessed 202 (4.4%)   certain 4438
resolved but callerless     2393
graph.db                    8.1 MB (8,433,664 bytes)
zero-symbol files           89 / 379
```

- [ ] **Step 2: Re-index this repo and record the same numbers**

```powershell
node plugins/p-graph/tools/pgraph.mjs index --full
node plugins/p-graph/tools/pgraph.mjs status
```

Then the three shares, with the same query used for the "before" column:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.pgraph/graph.db');const q=s=>db.prepare(s).all();for (const s of [`select count(*) c from edges where kind='call'`,`select count(*) c from edges where kind='call' and src_id is null`,`select count(*) c from edges where kind='call' and dst_id is not null`,`select count(*) c from edges where kind='call' and dst_id is not null and guess=1`]) console.log(s.slice(21), q(s)[0].c);"
```

Record: node count, edge count, `.pgraph/graph.db` size, the callerless share, the
guessed share, and the wall time of `index --full`.

- [ ] **Step 3: Check `search` did not fill up with test callbacks**

```powershell
node plugins/p-graph/tools/pgraph.mjs search openStore
node plugins/p-graph/tools/pgraph.mjs search config
```

Record how many of the top rows are callback definitions. A real definition must
still be reachable in the first few rows for a plain symbol name. If a plain
symbol name now answers with mostly test callbacks, that is a cost to state
plainly in the results doc — do not "fix" it by weakening the rule.

- [ ] **Step 4: Check `impact` did not explode**

```powershell
node plugins/p-graph/tools/pgraph.mjs impact openStore
node plugins/p-graph/tools/pgraph.mjs callers openStore
```

Record the size of the impact set before and after (before: run the same two
commands against a graph built from `git stash`-ed sources, or from the numbers in
Step 1 if already captured). Impact growing because tests now appear is correct —
say so and give the number.

- [ ] **Step 5: Run the precision audit — it must not move**

```powershell
node plugins/p-graph/scripts/measure.mjs --no-clone
```

Expected: exit 0, and the same figures the handoff publishes — 1,619 resolved /
1,411 certain / 208 guessed over the 22 symbols. A non-zero exit means a certain
row appeared that the source cannot explain, which this task must not cause.

If the clones are not on disk, the first run clones them (pinned SHAs are in the
script) and takes several minutes.

- [ ] **Step 6: Record the two headline repos from the handoff**

From the same `measure.mjs` run, or by indexing the pinned clones directly:

- nest `TestingModule.createNestApplication` — 190 rows today, 184 of them gap
  rows. Record how many gap rows became caller rows, and what those callers are
  named.
- got `end`, `exec`, `setHeader` — 826, 92 and 88 gap rows today. Record the same.
- Both repos' callerless share: got was 11,454/14,329 (80%), nest 28,448/38,315
  (74%). Record the new numbers and the new zero-symbol file counts (got 15/85,
  nest 393/1,728).

- [ ] **Step 7: Run the full repo suite on Windows**

Run: `npx vitest run`
Record: passed / skipped counts.

- [ ] **Step 8: Run the e2e suites under WSL**

Required by the project rule: the implementation was done on Windows, and tests
guarded by `describe.skipIf(process.platform === 'win32')` never execute there.

```bash
wsl -e bash -lc 'cd ~/pshed && git status --porcelain | head'
```

Copy the current tree in without touching the Windows `node_modules`:

```bash
wsl -e bash -lc 'mkdir -p ~/pshed'
tar --exclude=./node_modules --exclude=./.git --exclude=./.pgraph -cf - . | wsl -e bash -lc 'cd ~/pshed && tar -xf -'
wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npm install --silent && npx vitest run 2>&1 | tail -30'
```

If `~/.local/node24` is missing, unpack a portable Node first:

```bash
wsl -e bash -lc 'mkdir -p ~/.local/node24 && curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz | tar -xJ -C ~/.local/node24 --strip-components=1'
```

Record BOTH platforms' numbers. A Linux-only failure is a real failure.

- [ ] **Step 9: Write the results doc**

Create `plugins/p-graph/docs/superpowers/plans/2026-08-05-p-graph-ts-callback-defs-results.md`
with: the before/after table for this repo and for got and nest; the probe's
before/after output verbatim; what each of the three shares did; the `search` and
`impact` findings; the precision audit's exit code and figures; both platforms'
test counts; and an explicit list of what did NOT improve.

- [ ] **Step 10: Commit**

```bash
git add plugins/p-graph/docs/superpowers/plans/2026-08-05-p-graph-ts-callback-defs-results.md .superpowers/sdd/progress.md
git commit -m "docs(p-graph): measure what a named call-argument function changes"
```

---

### Task 3: Documentation, and the release proposal

**Files:**
- Modify: `plugins/p-graph/README.md`
- Modify: `plugins/p-graph/skills/query/SKILL.md`
- Modify: `plugins/p-graph/docs/superpowers/plans/2026-08-04-p-graph-follow-up.md`
- Modify: `plugins/p-graph/.claude-plugin/plugin.json` (version)

**Interfaces:**
- Consumes: the numbers Task 2 wrote down. Every figure quoted in a doc must come
  from that run, not from this plan.
- Produces: nothing code depends on.

- [ ] **Step 1: Find every claim the change touches**

```powershell
Select-String -Path plugins/p-graph/README.md,plugins/p-graph/skills/**/SKILL.md `
  -Pattern "outside any indexed symbol","no caller","callerless","test file","zero nodes","unattributed"
```

Read each hit. Any sentence saying a call inside a test callback has no caller is
now false for TS/JS and must be rewritten, not softened.

- [ ] **Step 2: State what a callback definition is, and what it is not**

Add to the README's name-resolution section, in plain words:

- A function passed as a call argument is indexed when no named definition
  encloses it, and is named after the call beside it (`it:my test`, `beforeEach@42`).
- An inline callback inside a named function is deliberately NOT indexed: the
  named function is the useful caller there.
- Such a definition is never the target of a call, so it adds no resolved edges
  and cannot make a certain row wrong.
- The cost, with the number from Task 2: node count and database size grow, and
  `search` has more rows in it.

- [ ] **Step 3: Update the query skill**

`plugins/p-graph/skills/query/SKILL.md` tells Claude how to read an answer. Add
one line: a caller named `it:…` or `beforeEach@…` is a test callback, and the
file:line is the place to look. Keep it to two sentences.

- [ ] **Step 4: Move the follow-up item**

`2026-08-04-p-graph-follow-up.md` — move the "a call-argument function is not a
definition" item into its "Fixed after this list was written" section, with the
recall numbers from Task 2 and the two shapes still not covered: a function in an
object literal passed as an argument (`foo({ onDone: () => … })`), and a callback
inside a named function (deliberate).

- [ ] **Step 5: Bump the plugin version**

`plugins/p-graph/.claude-plugin/plugin.json`: `1.2.0` → `1.3.0`. A new capture is
a backwards-compatible extension, so minor. No `SCHEMA_VERSION` bump is needed —
no column changes — but the graph must be rebuilt to see the new nodes, and
`index --full` is what users run anyway.

- [ ] **Step 6: Verify the docs against reality**

Re-run the probe from the handoff and machine-diff any banner quoted in a doc
against the real CLI output. A quoted banner that does not match byte-for-byte is
a defect.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-graph/README.md plugins/p-graph/skills/query/SKILL.md plugins/p-graph/docs/superpowers/plans/2026-08-04-p-graph-follow-up.md plugins/p-graph/.claude-plugin/plugin.json
git commit -m "docs(p-graph): say what a call-argument definition is, and bump to 1.3.0"
```

- [ ] **Step 8: Propose the release, and stop**

State the proposed monorepo tag (`v6.3.0` — p-graph 1.2.0 → 1.3.0 minor, no other
plugin touched) with the reasoning, and WAIT for an explicit go. Never tag or push
without it.

---

## Self-review

**Spec coverage.** The handoff asks for: the capture (Task 1 Step 3), the
enclosing-definition rule (Step 6), the naming rule including the `@line` fallback
(Step 4), the `KIND_SPECIFICITY` check confirmed with a two-callback fixture
(Task 1 Step 1, test 2, plus Step 8), the duplicate-qname question (Task 1 Step 1,
test 8 — a callback can never be a target, so Pass A never sees it), the four
measurements it names (Task 2 Steps 2-6), the node-count and database-size report
(Task 2 Step 2), and the `search` noise check (Task 2 Step 3). "Do not reopen
precision" is a global constraint and is checked in Task 2 Step 5.

**Placeholders.** None: every code step carries its code, every command its
expected output.

**Type consistency.** `CALLBACK_DEF_TYPES`, `callbackDefName`, `isCallback` and
`ownName` are used with the same names in Steps 4, 5 and 6.

**One gap the handoff leaves, decided here with a measurement, not a guess:** a
callback nested inside another callback. The literal rule indexes it, so a call
inside `expect(() => …)` inside `it('x', …)` reports `expect@16`. Rejecting the
refinement is justified by the 1,031 `beforeEach`/`afterEach` attributions it
would have destroyed — the numbers are in "Facts already measured" above.
