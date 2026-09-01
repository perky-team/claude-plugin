# Read what a class says it implements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the graph reporting that a class implements an interface when the source
says it implements a different one.

**Architecture:** TypeScript writes `implements X` down. Record it, then require a match
before calling a class an implementation. Where nothing is written down — Go, JavaScript,
a structurally-typed TS class — keep today's name-and-shape rule exactly as it is.

**Tech Stack:** Node 24+ for the suite (22.5+ for the plugin), `node:sqlite`, vendored
tree-sitter. No npm dependencies.

## Global Constraints

- **No new npm dependency.**
- **`SCHEMA_VERSION` must be bumped.** New `field_types` rows are stored, so an existing
  graph must be erased and rebuilt rather than read as current. It is 14 today.
- **Go and C++ must not change at all.** Go has no `implements` keyword: a type's method
  set *is* the rule, so name-and-shape is correct there and is the only thing available.
  The fallback gives that for free, but a test must pin it.
- **Every test run happens under WSL, and the whole suite** (see `.claude/CLAUDE.md`).
  Baseline: 294 files / 2,876 passed / 14 skipped, exit 0.
- **A `ts.scm` change triggers the project's re-measurement rule.** Ask before running it;
  state the cost (about $35 and 2.5 hours for the graph arm).
- Comments in **Simple English**, explaining WHY with the measured number.

---

## What was measured

`nest`, real clone, current code:

```
$ pgraph callers Serializer.serialize
ℹ 13 call sites of this method — on ClassSerializerInterceptor.serialize, which implements it:
ℹ 1  call site  … on IdentitySerializer.serialize, which implements it:
ℹ 13 call sites … on KafkaRequestSerializer.serialize, which implements it:
ℹ 2  call sites … on MqttRecordSerializer.serialize, which implements it:
ℹ 9  call sites … on NatsRecordSerializer.serialize, which implements it:
ℹ 2  call sites … on RmqRecordSerializer.serialize, which implements it:
```

What those six classes actually declare:

| Class | Declares | Real |
|---|---|---|
| `IdentitySerializer` | `implements Serializer` | yes |
| `KafkaRequestSerializer` | `implements Serializer<` | yes |
| `MqttRecordSerializer` | `implements Serializer<ReadPacket, string>` | yes |
| `NatsRecordSerializer` | `implements Serializer<` | yes |
| `RmqRecordSerializer` | `implements Serializer<` | yes |
| **`ClassSerializerInterceptor`** | **`implements NestInterceptor`** | **no** |

`ClassSerializerInterceptor` lives in `packages/common`, the interface lives in
`packages/microservices`, and the only thing they share is a method named `serialize`.

**The cost, measured in the four-language study.** The rule tells the agent that an `ℹ …
which implements it` row IS a call site of the method asked about and belongs in the main
list. The agent obeys. On `nest-serializer-serialize` that is 13 false rows per run, 39
over three runs — and **that one class is the only source of invented rows in the entire
study**: TypeScript 39, Go 0, Python 0, C++ 0.

### Why the gate is this weak

`implementationReach` accepts a candidate when: the name matches, the language matches,
the owner is not an interface, the owner has every non-optional member name the interface
declares, and `shapeSatisfies` passes on parameter count.

For a **single-method** interface, `need` holds one name, so the fourth gate reduces to
"the owner has a method called `serialize`". The fifth allows `impl.params <= iface.params`
for TypeScript. So the whole gate is *any class with a same-named method of compatible
arity*. nest has 312 interfaces and many of them declare one method.

### It predates both recent branches

Checked out and run at the tip of `p-graph-ts-js-one-family`: the same 13 rows, same
wording. Neither the ts/js work nor the file-scope work caused it.

### The clause is not recorded at all

`tools/lib/parse/lang/ts.scm:110` is the only heritage capture:

```scheme
(class_heritage (extends_clause) @ts.extends)
```

There is no `implements_clause` capture, so the graph has no way to know what a class says.

## Verified before planning

A wrong pattern does not just match nothing — the whole query file fails to compile and
every capture in it dies. So the pattern was compiled against the real grammar first,
together with the existing query:

```
baseline (no new pattern)                              -> OK, 10 nodes
+ (class_heritage (implements_clause) @ts.implements)  -> OK, 10 nodes
```

And the four ways a clause can be written, with the node types the driver will meet:

| Written | Named children | Base name is |
|---|---|---|
| `implements Serializer` | `type_identifier="Serializer"` | `.text` |
| `implements NestInterceptor, OnModuleInit` | two `type_identifier` | one row each |
| `implements Serializer<X, Y>` | `generic_type="Serializer<X, Y>"` | `namedChild(0).text` |
| `implements ns.Outer.Iface` | `nested_type_identifier="ns.Outer.Iface"` | the last segment |

## The rule this plan implements

> When a class declares what it implements, believe it. When it declares nothing, fall
> back to name and shape.

And one more, because a half-read picture is worse than no picture:

> If the class declares an interface the graph cannot resolve, fall back too. The guard
> only fires when the graph can read the whole picture.

That last line covers the two cases that would otherwise turn a false row into a lost
true one:

- **An alias.** `implements ProducerSerializer`, where
  `type ProducerSerializer = Serializer<…>`. `#alias:` rows already exist for this —
  follow one hop.
- **An interface extending another.** `interface Y extends X { … }`, class declares
  `implements Y`. `ts.scm` reads no members off an interface `extends` clause — the
  existing comment above `interfaceReach` says so. So `Y` resolves to a repo interface
  whose member set is short, and an exact-name check would wrongly skip the candidate.
  Treat "declared name resolves to a repo interface that is not the target" as a skip
  ONLY when the target is not reachable from it; otherwise fall back. Simplest safe
  reading: skip only when **every** declared name resolves to a repo interface and none
  of them is the target or an alias of it.

## File Structure

| File | Responsibility |
|---|---|
| `tools/lib/parse/lang/ts.scm` | Modify — capture the implements clause |
| `tools/lib/parse/driver.mjs` | Modify — one `field_types` row per declared interface |
| `tools/lib/destinations/local-sqlite.mjs` | Modify — the guard in `implementationReach`; `SCHEMA_VERSION` |
| `tools/__tests__/ts-implements-clause.test.ts` | Create — the four written shapes become rows |
| `tools/__tests__/implementation-declared.test.ts` | Create — the guard, its fallbacks, and Go untouched |

---

### Task 1: Record what a class says it implements

**Files:**
- Modify: `tools/lib/parse/lang/ts.scm` (beside the `ts.extends` capture, around line 110)
- Modify: `tools/lib/parse/driver.mjs` (beside the `ts.extends` reader, around line 2073)
- Modify: `tools/lib/destinations/local-sqlite.mjs` (`SCHEMA_VERSION`, line 91)
- Test: `tools/__tests__/ts-implements-clause.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: for `class C implements A, B`, four `field_types` rows —
  `C#implements:A`, `<file>|C#implements:A`, `C#implements:B`, `<file>|C#implements:B` —
  each with `type` `'1'`. The name is a marker, not a type; the key carries the fact.
  Task 2 reads them.

**Why one row per pair, and not one `C#implements` row holding a name:** every reader of
`field_types` folds a key to a single value and poisons it when two rows disagree
(`resolveTsFieldTypes` does exactly that). A class implementing two interfaces would
cancel itself out. One row per pair cannot conflict.

- [ ] **Step 1: Write the failing test**

Create `tools/__tests__/ts-implements-clause.test.ts`. Use the `write` / `indexed`
helpers exactly as `tools/__tests__/ts-field-types.test.ts` does — read that file first.
Read the rows through the store's own `field_types` accessor if one exists; if not, query
the table through the store the way `store-fieldtypes.test.ts` does.

Assert one case per written shape, using the table in "Verified before planning":

```ts
  it('records a plain implements clause', async () => {
    write('lib/a.ts', `export interface Serializer { serialize(v: unknown): string; }
export class A implements Serializer {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'A')).toEqual(['Serializer']);
    store.close();
  }, 30000);

  it('records every interface in a list', async () => {
    // A class implementing two interfaces must not cancel itself out. Every reader of
    // field_types folds a key to one value and poisons it when two rows disagree, so
    // the interface name lives in the KEY, one row per pair.
    write('lib/b.ts', `export class B implements NestInterceptor, OnModuleInit {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'B').sort()).toEqual(['NestInterceptor', 'OnModuleInit']);
    store.close();
  }, 30000);

  it('strips the type arguments', async () => {
    write('lib/c.ts', `export class C implements Serializer<X, Y> {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'C')).toEqual(['Serializer']);
    store.close();
  }, 30000);

  it('keeps only the last segment of a nested name', async () => {
    write('lib/d.ts', `export class D implements ns.Outer.Iface {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'D')).toEqual(['Iface']);
    store.close();
  }, 30000);

  it('records nothing for a class that declares nothing', async () => {
    write('lib/e.ts', `export class E {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'E')).toEqual([]);
    store.close();
  }, 30000);

  // `extends` and `implements` sit in the same class_heritage node. Reading one must
  // not disturb the other — `#extends` is what the field-type resolver walks to find
  // a field declared on a base class.
  it('leaves the extends row alone', async () => {
    write('lib/f.ts', `export class F extends Base implements Serializer {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'F')).toEqual(['Serializer']);
    expect(extendsOf(store, 'F')).toBe('Base');
    store.close();
  }, 30000);
```

Write `implementsOf` and `extendsOf` as local helpers over the store's `field_types`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-implements-clause.test.ts`

Expected: FAIL on the first four cases (no rows exist). The last two pass already — the
"declares nothing" case and the `#extends` half of the last one.

- [ ] **Step 3: Add the capture**

In `tools/lib/parse/lang/ts.scm`, below the `ts.extends` capture, with a comment saying
what it buys and what it costs — measured, per the plan's opening:

```scheme
;; `class C implements Serializer` — what the class SAYS it implements. Without it the
;; graph guessed, and it guessed wrong: `callers Serializer.serialize` on nest reported
;; 13 call sites "on ClassSerializerInterceptor.serialize, which implements it", and that
;; class declares `implements NestInterceptor`, in another package. Those 13 rows per run
;; were the ONLY source of invented rows in the whole four-language study.
(class_heritage (implements_clause) @ts.implements)
```

- [ ] **Step 4: Read it in the driver**

Beside the `ts.extends` loop (around `driver.mjs:2073`), mirroring its shape. Iterate
**every** named child, not just the first, and reduce each to a base name using the node
types measured in the plan:

```js
    // Every interface the clause names, one row per pair. `implements A, B` is
    // ordinary code, and a single `<Class>#implements` key holding a name would
    // cancel itself out — every field_types reader folds a key to one value and
    // poisons it when two rows disagree. So the fact lives in the KEY and the value
    // is a marker.
    //
    // Three node shapes, all measured against the grammar: `type_identifier` for a
    // plain name, `generic_type` whose first named child is the name for
    // `Serializer<X, Y>`, and `nested_type_identifier` for `ns.Outer.Iface`, where
    // only the last segment can match a stored qname.
    for (const c of caps) {
      if (c.name !== 'ts.implements') continue;
      const cls = defs.filter((d) => d.kind === 'class' && within(c, d)).sort(innermostFirst)[0];
      if (!cls) continue;
      for (let i = 0; i < c.node.namedChildCount; i++) {
        const n = c.node.namedChild(i);
        const raw = n.type === 'generic_type' ? n.namedChild(0)?.text : n.text;
        const name = raw ? raw.split('.').pop() : null;
        if (!name || name === cls.name) continue;
        fieldTypes.push({ key: `${cls.name}#implements:${name}`, type: '1', file });
        fieldTypes.push({ key: `${file}|${cls.name}#implements:${name}`, type: '1', file });
      }
    }
```

- [ ] **Step 5: Bump the schema version**

`field_types` gains rows, so a graph written by the old code must be rebuilt. In
`local-sqlite.mjs`, add entry 15 to the numbered list in the same voice as 13 and 14:

```js
// 15: a TypeScript class records what it declares it implements, as one
// `<Class>#implements:<Iface>` field_types row per pair. Stored rows change for
// every repo with an implements clause, so the graph is rebuilt.
export const SCHEMA_VERSION = 15;
```

- [ ] **Step 6: Run the test, then the neighbours**

```bash
npx vitest run plugins/p-graph/tools/__tests__/ts-implements-clause.test.ts
npx vitest run plugins/p-graph/tools/__tests__/lang-ts.test.ts \
  plugins/p-graph/tools/__tests__/ts-field-types.test.ts \
  plugins/p-graph/tools/__tests__/store-fieldtypes.test.ts \
  plugins/p-graph/tools/__tests__/alias-resolution.test.ts \
  plugins/p-graph/tools/__tests__/driver.test.ts
```

Expected: PASS. Then run the **whole** suite before committing — this is a `ts.scm`
change and a schema bump, and a curated list has already let a red suite through on this
project once.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/lang/ts.scm \
        plugins/p-graph/tools/lib/parse/driver.mjs \
        plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/ts-implements-clause.test.ts
git commit -m "feat(p-graph): record what a TypeScript class says it implements"
```

---

### Task 2: Believe the declaration when there is one

**Files:**
- Modify: `tools/lib/destinations/local-sqlite.mjs` (`implementationReach`, the candidate loop around line 2155)
- Test: `tools/__tests__/implementation-declared.test.ts`

**Interfaces:**
- Consumes: `<Class>#implements:<Iface>` rows from Task 1.
- Produces: nothing further.

The guard, stated once so the implementer can check each case against it:

1. Collect the interface names the candidate's owner declares.
2. If it declares **none** — Go, JavaScript, a structurally-typed TS class — keep today's
   name-and-shape rule untouched.
3. If it declares some, and one of them names this interface (directly, or through one
   `#alias:` hop), accept.
4. If it declares some, and **any** of them cannot be resolved to an interface the graph
   knows, keep today's rule. A half-read picture must not lose a true row.
5. Only when every declared name resolves to a known repo interface and none is this one:
   skip the candidate.

- [ ] **Step 1: Write the failing test**

Create `tools/__tests__/implementation-declared.test.ts`. One case per numbered rule
above, plus the measured nest shape. Use the same `write`/`indexed` helpers as
`tools/__tests__/interface-reach.test.ts` — read that file first and mirror how it asserts
on reach rows.

```ts
  // The measured case. `ClassSerializerInterceptor` in nest declares
  // `implements NestInterceptor` and lives in another package; the only thing it shares
  // with `Serializer` is a method named `serialize`. Its 13 call sites per run were the
  // only source of invented rows in the whole four-language study.
  it('does not call a class an implementation when it declares another interface', async () => {
    write('micro/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown, options?: Record<string, any>): string;
}
`);
    write('micro/identity.serializer.ts', `import { Serializer } from './serializer.interface';
export class IdentitySerializer implements Serializer {
  serialize(value: unknown) { return String(value); }
}
`);
    write('common/class-serializer.interceptor.ts', `export class ClassSerializerInterceptor implements NestInterceptor {
  serialize(value: unknown) { return String(value); }
}
`);
    write('common/use.ts', `import { ClassSerializerInterceptor } from './class-serializer.interceptor';
export function run(i: ClassSerializerInterceptor) { return i.serialize(1); }
`);
    write('micro/use.ts', `import { IdentitySerializer } from './identity.serializer';
export function run(s: IdentitySerializer) { return s.serialize(1); }
`);
    const store = await indexed();

    const via = store.gapsFor('Serializer.serialize')
      .filter((r) => r.reason === 'implementation').map((r) => r.via);
    expect(via).toContain('IdentitySerializer.serialize');
    expect(via).not.toContain('ClassSerializerInterceptor.serialize');
    store.close();
  }, 30000);
```

Then a case for each of these, in the same file:

- **Rule 2, JavaScript:** a `.js` class with a same-named method and no clause is still
  reported. JavaScript has no `implements` syntax at all.
- **Rule 2, Go — the one that must not move.** A Go type never declares what it
  implements; its method set is the whole rule. Build the caddy shape: an interface with
  one method, two types with that method, and calls on both. Assert **both** are still
  reported. This is the test that stops the fix leaking out of TypeScript.
- **Rule 3, through an alias:** `type ProducerSerializer = Serializer<…>` and
  `class P implements ProducerSerializer`. Assert `P` is reported.
- **Rule 4, unreadable declaration:** `class Q implements SomethingNotInThisRepo` with a
  same-named method. Assert `Q` **is** reported — the graph cannot see what
  `SomethingNotInThisRepo` is, so it must not skip.
- **Rule 5 boundary:** a class declaring two interfaces the repo defines, neither of them
  the target. Assert it is skipped.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/implementation-declared.test.ts`

Expected: FAIL on the nest case and on the rule-5 case. The rule-2, rule-3 and rule-4
cases pass already — they pin behaviour that must survive.

- [ ] **Step 3: Add the guard**

In `implementationReach`, after `const owner = ownerOf(cand);` and its interface check,
before the `need`/`shapeSatisfies` gates. Read the declared names once per owner and
cache them across the candidate loop — the loop can run over hundreds of candidates on a
common method name.

Write the comment to carry the measured number and the reason for rule 4.

- [ ] **Step 4: Run the test, then the whole suite**

```bash
npx vitest run plugins/p-graph/tools/__tests__/implementation-declared.test.ts \
  plugins/p-graph/tools/__tests__/interface-reach.test.ts \
  plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts \
  plugins/p-graph/tools/__tests__/cli-interface-reach.test.ts \
  plugins/p-graph/tools/__tests__/go-interface-members.test.ts \
  plugins/p-graph/tools/__tests__/ts-interface-members.test.ts \
  plugins/p-graph/tools/__tests__/sig-shape.test.ts
```

Then the whole suite. A failure in the Go or the interface-reach files means the guard
leaked past TypeScript — report the assertion, do not weaken it.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/implementation-declared.test.ts
git commit -m "fix(p-graph): a class implements what it says it implements"
```

---

### Task 3: Verify on the real clones, then ask about re-measuring

**Files:**
- Modify: `plugins/p-graph/docs/measured-benefit.md`
- Modify: this plan (record what was measured)

- [ ] **Step 1: Run the whole suite under WSL**

The deciding platform. A Windows-only run verifies nothing here.

```bash
wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd /mnt/c/projects/perky.team/claude-plugin && tar --exclude=./node_modules --exclude=./.git --exclude=./.beads -cf - . | (cd ~/pshed && tar -xf -) && cd ~/pshed && npx vitest run 2>&1 | tail -6'
```

Baseline: 294 files / 2,876 passed / 14 skipped, exit 0. Report both platforms and say
which is the WSL run.

- [ ] **Step 2: Check the measured case on the real nest clone**

The schema bump erases the graph, so this is a full rebuild.

```bash
W="/c/Users/Andrey.Sukharev/AppData/Local/Temp/pgraph-measure"
P=/c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs
(cd "$W/nest" && node "$P" index && node "$P" callers Serializer.serialize)
```

Expected: five `ℹ … which implements it` groups, not six.
`ClassSerializerInterceptor.serialize` must be gone and the other five must all still be
there. If a true one disappeared, that is a regression — stop and report which.

- [ ] **Step 3: Count what the guard skipped across every clone**

A guard that fires too often loses true rows quietly. Count, per repo, how many
`implementation` reach rows exist before and after, and how many candidates the guard
skipped. Rebuild each clone with the pre-branch code from a worktree to get the "before"
side, exactly as the previous branch did:

```bash
git worktree add /tmp/pg-base <the commit before Task 1>
# index a clone with each copy of the plugin, count `reason === 'implementation'` rows
git worktree remove /tmp/pg-base --force
```

Report the table. The number that matters: rows lost on the five nest serializers and on
every Go interface must be **zero**.

- [ ] **Step 4: Ask about the re-measurement**

This changes `ts.scm` and how names resolve, so `.claude/CLAUDE.md` requires asking before
any published number is treated as still true. State the cost: about **$35** and 2.5 hours
for the graph arm, all fourteen repositories.

The expected move, so the answer can be checked against a prediction rather than accepted:
**TypeScript invented rows 39 → 0**, and with it the study's only non-zero invented count
for p-graph. Recall should not move: the 20 true call sites of
`nest-serializer-serialize` come from `interfaceReach`, not from the implementation
groups.

```bash
node plugins/p-graph/scripts/measure-agent.mjs --phase graph
node plugins/p-graph/scripts/measure-agent.mjs --score
```

Before re-running, delete the graph rows from `runs.jsonl` — the runner never repeats a
run. The extraction cache is now keyed on the answer, so it can no longer serve a stale
extraction; that trap cost a full scoring pass once already.

- [ ] **Step 5: Update the report and print the full scoreboard**

Correct `measured-benefit.md`, and end with the complete four-language, three-arm table —
not a delta. A partial table is how this study has twice published a wrong headline.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-graph/docs/
git commit -m "docs(p-graph): re-measure after a class implements what it says"
```

---

## What is deliberately not built

- **No interface `extends` member reading.** `ts.scm` reads no members off an interface's
  own `extends` clause, and that hole is why rule 4 exists. Closing it is separate work.
- **No change to Go or C++.** Neither writes an implements clause. Go's method-set rule is
  correct as it stands.
- **No change to `shapeSatisfies`.** The parameter-count rule stays as measured; this plan
  adds a gate in front of it, it does not loosen or tighten it.
