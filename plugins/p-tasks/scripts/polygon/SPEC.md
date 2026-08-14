# Feature: a config resolver

Build a small library and a CLI that reads a config file, lays command-line
flags over it, fills in defaults, checks it against a schema, and prints the
result.

Ten requirements. Each names the file it lives in and the exact names it must
export. **Keep those paths and names exactly as written** — other code imports
them.

## R1 — parse an INI file

`src/parse.js` exports `parseIni(text)`.

Returns a plain object: section name to an object of key to string value.
Lines are `[section]`, `key = value`, blank, or `# comment`.
Keys outside any section go in the section `""`.
On any other line, throw a `SyntaxError` whose message is `line <n>: <the line>`,
counting from 1.

```js
parseIni('[a]\nx = 1\n')   // { a: { x: '1' } }
```

## R2 — check a value against a schema

`src/schema.js` exports `validate(config, schema)`.

A schema is `{ '<section>.<key>': { type, required, default } }` where `type` is
`'string'`, `'number'` or `'boolean'`.

Returns `{ ok: true, value }` where `value` has numbers and booleans converted,
or `{ ok: false, errors }` where each error is `{ path, message }`.

Messages, exactly:
- missing and required: `is required`
- not a number: `must be a number`
- not a boolean: `must be true or false`

`'true'` and `'false'` are the only booleans. A number is anything
`Number.isFinite` accepts after `Number(value)`, and an empty string is not one.
Errors come back sorted by `path`.

`value` holds only the paths the schema names. A key the schema does not name is
left out.

## R3 — fill in defaults

`src/defaults.js` exports `applyDefaults(config, schema)`.

Returns a new config with every schema path that has a `default` and no value
filled in. Never changes the input. Runs before validation, so a default of `1`
for a number path is written as the string `'1'`.

## R4 — merge layers

`src/merge.js` exports `mergeLayers(layers)`.

Takes an array of configs and merges them section by section, later layers
winning key by key. Never changes the inputs.

## R5 — parse command-line flags

`src/flags.js` exports `parseFlags(argv)`.

Returns `{ set, rest }`. `set` is a config in the same shape `parseIni` returns.
- `--section.key=value` sets that key.
- `--section.key value` does the same.
- `--flag` on its own sets `flag` in section `""` to `'true'`.
- Anything else goes to `rest`, in order.

## R6 — resolve everything

`src/resolve.js` exports `resolve({ text, argv, schema })`.

The whole pipeline: parse the text (R1), parse the flags (R5), merge with flags
last (R4), apply defaults (R3), validate (R2). Returns exactly what `validate`
returns.

## R7 — format errors

`src/errors.js` exports `formatErrors(errors)`.

Returns one line per error, `<path>: <message>`, joined by `\n`, in the order
given. An empty array gives an empty string.

## R8 — print as JSON

`src/report.js` exports `toJson(value)`.

`JSON.stringify` with two-space indent, and **keys sorted** at every level, so
the same config always prints the same bytes. No trailing newline.

## R9 — CLI exit codes

`bin/cli.js` reads a config path as its first argument and flags after it.

It always validates against this fixed schema, whatever the config holds:

| path | type | required | default |
|---|---|---|---|
| `server.port` | number | yes | — |
| `server.host` | string | no | `localhost` |
| `server.debug` | boolean | no | `false` |

| exit | when |
|---|---|
| 0 | resolved and valid |
| 2 | the file could not be parsed (R1 threw) |
| 3 | validation failed |
| 64 | no config path given |

On 2 and 3 it prints the message to stderr — the `SyntaxError` message for 2,
`formatErrors` output for 3.

## R10 — `--json`

With `--json` anywhere in the arguments, a successful run prints `toJson` of the
resolved value to stdout and nothing else. `--json` is not a config key and
never appears in the result.

---

Fifty more requirements follow, R11 to R60, growing the same feature. Same
rule as above: **keep the paths and names exactly as written.** R1 to R10 are
implemented, tested and proven — nothing below changes them; everything below
only adds. Where one requirement builds on an earlier one, its text says so
by number.

### Type system: integers, lists

## R11 — split a path on its last dot

`src/paths.js` exports `splitPath(path)` and `joinPath(section, key)`.

A schema path like `'server.tls.cert'` names section `'server.tls'` (from an
INI header `[server.tls]`) and key `'cert'` — the section is everything
*before* the last dot, the key is everything after it. `splitPath` returns
`[section, key]`. A path with no dot throws a `TypeError` whose message is
`bad path: <path>`.

`joinPath` is the inverse: `joinPath(section, key)` returns `` `${section}.${key}` ``,
except when `section` is `''`, where it returns `key` alone (no leading dot).

```js
splitPath('server.tls.cert')   // ['server.tls', 'cert']
splitPath('port')              // throws TypeError('bad path: port')
joinPath('server.tls', 'cert') // 'server.tls.cert'
joinPath('', 'verbose')        // 'verbose'
```

Every requirement below that needs to read or name a dotted path uses these
two functions, not a bare `path.split('.')` — that is how a section name that
itself contains a dot (`server.tls`) stays in one piece.

## R12 — an `integer` type

`src/types.js` exports `coerceExtraTypes(value, schema)`.

`value` is a config already shaped like R2's `validate` output: numbers and
booleans converted, everything else still a string. `schema` is the same
kind of object R2 takes, now allowed to carry `type: 'integer'` on a path.

For each schema path whose `type` is `'integer'` and whose value is present
in `value` (via R11's `splitPath`): the string must match `/^-?\d+$/` exactly.
On a match, replace it with `Number(...)` of itself. On no match, produce an
error `{ path, message: 'must be an integer' }` and leave that path out of
the returned value.

A path missing from `value` is left out of the result — R2 already decided
whether that was an error (`required`) or fine (optional, no default); this
function never re-decides that.

Returns `{ ok: true, value }` (a new object; every non-`integer` path is
copied over unchanged) or `{ ok: false, errors }`, errors sorted by path with
R2's plain string compare.

```js
coerceExtraTypes({ a: { x: '3' } }, { 'a.x': { type: 'integer' } })
// { ok: true, value: { a: { x: 3 } } }
coerceExtraTypes({ a: { x: '3.5' } }, { 'a.x': { type: 'integer' } })
// { ok: false, errors: [{ path: 'a.x', message: 'must be an integer' }] }
```

## R13 — a `list` type

Same `coerceExtraTypes` (R12), one more `type` value: `'list'`.

The string is split on `,`; each piece is trimmed; the result is an array of
strings. The empty string is special-cased to `[]` (not `['']`, which is what
a plain `''.split(',')` would give).

```js
coerceExtraTypes({ a: { x: 'foo, bar ,baz' } }, { 'a.x': { type: 'list' } })
// { ok: true, value: { a: { x: ['foo', 'bar', 'baz'] } } }
coerceExtraTypes({ a: { x: '' } }, { 'a.x': { type: 'list' } })
// { ok: true, value: { a: { x: [] } } }
```

A `list` never fails to coerce — every string is a valid list of strings.

## R14 — a `list<integer>` type

Same `coerceExtraTypes` (R12), one more `type` value: `'list<integer>'`.

Split and trim as R13, then every piece must match `/^-?\d+$/` (R12's rule)
and is converted with `Number(...)`. If **any** piece fails, the whole path
produces one error, message `must be a list of integers` — not one error per
bad piece.

```js
coerceExtraTypes({ a: { x: '1, 2, 3' } }, { 'a.x': { type: 'list<integer>' } })
// { ok: true, value: { a: { x: [1, 2, 3] } } }
coerceExtraTypes({ a: { x: '1, x, 3' } }, { 'a.x': { type: 'list<integer>' } })
// { ok: false, errors: [{ path: 'a.x', message: 'must be a list of integers' }] }
```

## R15 — a `list<boolean>` type

Same `coerceExtraTypes` (R12), one more `type` value: `'list<boolean>'`.

Split and trim as R13. Every piece must be exactly `'true'` or `'false'`
(R2's rule for booleans) and is converted to a JS boolean. If any piece is
neither, the whole path produces one error, message
`must be a list of true/false values`.

```js
coerceExtraTypes({ a: { x: 'true, false, true' } }, { 'a.x': { type: 'list<boolean>' } })
// { ok: true, value: { a: { x: [true, false, true] } } }
```

When two or more paths fail across a call, `coerceExtraTypes` reports one
error per bad *path* (never per item), sorted by path.

## R16 — a default for a `list`-typed path

This is a worked example, not new code: given
`{ 'a.tags': { type: 'list', default: ['x', 'y'] } }`, R3's `applyDefaults`
is untouched and still runs `String(rule.default)` — and `String(['x', 'y'])`
is the plain JS string `'x,y'`, because that is what `Array.prototype.toString`
does. So the filled-in raw value is `'x,y'`. Feeding that through R13's
`coerceExtraTypes` with the same schema gives back `['x', 'y']`.

```js
applyDefaults({}, { 'a.tags': { type: 'list', default: ['x', 'y'] } })
// { a: { tags: 'x,y' } }
coerceExtraTypes({ a: { tags: 'x,y' } }, { 'a.tags': { type: 'list', default: ['x', 'y'] } })
// { ok: true, value: { a: { tags: ['x', 'y'] } } }
```

An array `default` needs no special-casing anywhere — it works because
`String()` on an array already does the right thing.

### More sources to layer

## R17 — an environment-variable layer

`src/env.js` exports `envToConfig(env, prefix)`.

Pure function: `env` is a plain object standing in for environment variables
(never `process.env` read directly inside this function — see R46 for the
one place that happens). For every own key of `env` that starts with
`` `${prefix}__` `` (the prefix, then two underscores), take what follows,
split it on the **first** remaining `__`, and use the two halves as section
and key, verbatim, no case change. The value is `String(env[key])`. Keys that
don't match the pattern are ignored — that includes a key whose remainder (after
the prefix) has no further `__` at all, which has no way to split into a
section and a key, and is ignored the same way.

```js
envToConfig({ APP__server__port: '9', OTHER: 'x' }, 'APP')
// { server: { port: '9' } }
```

## R18 — an include-by-name layer

`src/include.js` exports `resolveIncludes(config, files)`.

Pure function, no file system access — `files` is a plain object the caller
already filled in, mapping a file name to its already-read text. `config` is
shaped like R1's `parseIni` output.

If `config['']?.include` is set (its value is a file name), parse that
name's text from `files` with R1's `parseIni`, then merge with R4's
`mergeLayers([included, config])` — the included file is the lower-priority
layer, `config` overrides it. The `include` key itself is removed from the
`''` section of the result; every other key in that section is kept. If
removing `include` leaves that section with no keys at all, the `''` section
itself is dropped from the result — as the worked example below shows. This
does **not** resolve an `include` found inside the included file itself —
one level only.

If `config['']?.include` is not set, return a copy of `config`, unchanged
(never mutate the input, same rule as R4).

If the named file is not a key of `files`, throw a `SyntaxError` whose
message is `no such include: <name>`.

```js
resolveIncludes(
  { '': { include: 'base.ini' }, server: { port: '9' } },
  { 'base.ini': '[server]\nhost = example.com\n' }
)
// { server: { host: 'example.com', port: '9' } }
```

## R19 — schema defaults as a layer

`src/defaultsLayer.js` exports `defaultsAsLayer(schema)`.

Pure function: for every schema path that has a `default`, returns a config
(R1's shape) with that path set to `String(rule.default)` — the exact same
stringification R3 uses (see R16). Paths without a `default` are left out.
This turns "the schema's defaults" into a plain config object that R4's
`mergeLayers` can take as just another layer — that is the whole point of
this function: it exists so a defaults layer can be *named* in a provenance
report (R33), which R3's `applyDefaults` has no way to do.

```js
defaultsAsLayer({ 'server.host': { type: 'string', default: 'localhost' } })
// { server: { host: 'localhost' } }
```

## R20 — resolve with layers, named

`src/pipeline.js` exports `resolveLayers({ text, argv, env, envPrefix, includeFiles, schema })`.

A richer sibling of R6's `resolve`, built from R1, R2, R4, R5, R12–R15, R17,
R18 and R19:

1. `fromFile = parseIni(text)` (R1).
2. `withIncludes = resolveIncludes(fromFile, includeFiles)` (R18).
3. `fromEnv = envToConfig(env, envPrefix)` (R17).
4. `fromFlags = parseFlags(argv).set` (R5).
5. `defaultsLayer = defaultsAsLayer(schema)` (R19).
6. `merged = mergeLayers([defaultsLayer, withIncludes, fromEnv, fromFlags])` (R4)
   — defaults lowest, then file (with its includes already folded in), then
   env, then flags highest. This does **not** also call R3's
   `applyDefaults` — step 5 already supplied every default as a layer, so
   calling it again would be redundant, not wrong, and this function skips it.
7. `validated = validate(merged, schema)` (R2). If `!validated.ok`, return
   `validated` as-is.
8. Return `coerceExtraTypes(validated.value, schema)` (R12–R15).

```js
resolveLayers({
  text: '[server]\nport = 9\n',
  argv: ['--server.host=x'],
  env: {},
  envPrefix: 'APP',
  includeFiles: {},
  schema: { 'server.port': { type: 'integer', required: true }, 'server.host': { type: 'string' } },
})
// { ok: true, value: { server: { port: 9, host: 'x' } } }
```

## R21 — a list is replaced whole, never appended

Given R20's `resolveLayers` with a `list`-typed path, when both the file and
the flags set it, the flag's value **replaces** the file's value entirely —
R4's `mergeLayers` is a key-by-key override, applied to the raw string
before R13/R14/R15 ever run, so there is no "combine the two lists" step
anywhere in the pipeline.

```js
resolveLayers({
  text: '[db]\nhosts = a,b,c\n',
  argv: ['--db.hosts=x,y'],
  env: {}, envPrefix: 'APP', includeFiles: {},
  schema: { 'db.hosts': { type: 'list' } },
})
// { ok: true, value: { db: { hosts: ['x', 'y'] } } }   -- not ['a','b','c','x','y']
```

### More validation rules

Every check function from here through R31 (`checkRange`, `checkOneOf`,
`checkPattern`, `checkRequiredTogether`, `checkMutuallyExclusive`,
`checkUnknownKeys`, `checkLength`, `checkRequiredIf`, `checkListLength`,
`checkUnique`) returns exactly `{ ok: true }` when it has nothing to report,
or `{ ok: false, errors }` otherwise — the same two-shape contract as R2,
`errors` sorted by path with R2's plain string compare. Only the per-function
text below says which paths it looks at and what message it writes; the
return shape itself is this one rule, stated once here.

## R22 — minimum and maximum

`src/rules.js` exports `checkRange(value, schema)`.

`value` is a coerced config (numbers/integers already converted, by R2 and/or
R12) — `min`/`max` are only ever placed on a `number` or `integer` path; a
schema that puts them on any other type is outside this requirement's scope.
For each schema path carrying `min` and/or `max` and present in
`value`: if `value < min`, error `must be at least <min>`; else if
`value > max`, error `must be at most <max>` — at most one range error per
path, min checked first.

## R23 — one of a fixed set of values

`src/rules.js` exports `checkOneOf(rawConfig, schema)`.

`rawConfig` is a config **before** type coercion (still raw strings) — this
check compares raw text, so it works for any `type`. For each schema path
carrying `oneOf` (an array of allowed strings) and present in `rawConfig`: if
the raw string is not one of them, error
`` must be one of <oneOf.join(', ')> `` (values in the order given in the
schema).

## R24 — a pattern

`src/rules.js` exports `checkPattern(rawConfig, schema)`.

For each schema path carrying `pattern` (a string) and present in
`rawConfig`: test `new RegExp(pattern).test(rawValue)`, unanchored, exactly
as written — this function does not add `^`/`$` for you. On no match, error
`` must match <pattern> ``.

## R25 — required together

`src/rules.js` exports `checkRequiredTogether(rawConfig, groups)`.

`groups` is an array of arrays of paths, e.g. `[['db.user', 'db.pass']]`,
given separately from the schema (it is a relationship between paths, not a
property of one path). For each group: if **any** path in it is present in
`rawConfig`, every path in it must be present. Each missing path in that case
gets its own error, message
`` must be set together with <the group's other paths, in group order, comma-and-space joined, excluding itself> ``.
If none of a group's paths are present, that group produces no error.

```js
checkRequiredTogether({ db: { user: 'a' } }, [['db.user', 'db.pass']])
// { ok: false, errors: [{ path: 'db.pass', message: 'must be set together with db.user' }] }
```

## R26 — mutually exclusive

`src/rules.js` exports `checkMutuallyExclusive(rawConfig, groups)`.

Same `groups` shape as R25. For each group, if **two or more** of its paths
are present in `rawConfig`, every present path gets an error naming the
*other* present paths (not the whole group, only the ones actually set), in
group order, comma-and-space joined: `` cannot be set together with <...> ``.
A group with zero or one path present produces no error.

## R27 — unknown keys (strict mode)

`src/rules.js` exports `checkUnknownKeys(rawConfig, schema)`.

Pure, opt-in check (R2 itself never looks at keys the schema doesn't name,
and that does not change). Walks every section/key in `rawConfig`, builds
its dotted path with R11's `joinPath`, and for every path that is **not** a
key of `schema`, produces an error `{ path, message: 'unknown key' }`.

## R28 — string length

`src/rules.js` exports `checkLength(rawConfig, schema)`.

For each schema path carrying `minLength` and/or `maxLength`, present in
`rawConfig`, and whose `type` is `'string'` or unset (any other `type` is
ignored by this check): the raw string's `.length` must be `>= minLength`
and `<= maxLength`. Errors, at most one per path (minLength checked first):
`must be at least <n> characters`, `must be at most <n> characters`.

## R29 — required if another path has a value

`src/rules.js` exports `checkRequiredIf(rawConfig, schema)`.

A schema path may carry `requiredIf: { path, equals }` (`path` read with
R11's `splitPath`). If `rawConfig` at `path` has the raw string value
`equals`, then the carrying path must itself be present in `rawConfig`; if
it is not, error `` is required when <path> is <equals> ``.

## R30 — list item count

`src/rules.js` exports `checkListLength(value, schema)`.

`value` is the config **after** R12–R15's coercion (`list`/`list<integer>`/
`list<boolean>` paths already hold arrays). For each schema path carrying
`minItems` and/or `maxItems` and present in `value`: the array's `.length`
must be `>= minItems` and `<= maxItems`. Errors, at most one per path
(minItems first): `must have at least <n> items`, `must have at most <n> items`.

## R31 — no duplicate list items

`src/rules.js` exports `checkUnique(value, schema)`.

Same coerced `value` as R30. For each schema path carrying `unique: true`
and present in `value` as an array: if any two items are `===` equal (after
R12–R15's coercion — so two integers compare numerically, two strings as
strings), error `must not repeat a value`. One error per path, regardless of
how many duplicates it has.

## R32 — aggregate every check into one result

`src/aggregate.js` exports
`collectErrors({ rawConfig, schema, requiredTogetherGroups, mutuallyExclusiveGroups })`.

The full second-generation pipeline, built from R2, R12–R15, and R22–R31:

1. `validated = validate(rawConfig, schema)` (R2). If it fails, return
   `{ ok: false, stage: 'basic', errors: validated.errors }`.
2. `typed = coerceExtraTypes(validated.value, schema)` (R12–R15). If it
   fails, return `{ ok: false, stage: 'basic', errors: typed.errors }`.
3. Run all nine of the following against `typed.value` or `rawConfig` as
   marked, **all of them, regardless of whether an earlier one failed** —
   this is the aggregation: `checkRange(typed.value, schema)` (R22, typed),
   `checkLength(rawConfig, schema)` (R28, raw),
   `checkListLength(typed.value, schema)` (R30, typed),
   `checkUnique(typed.value, schema)` (R31, typed),
   `checkOneOf(rawConfig, schema)` (R23, raw),
   `checkPattern(rawConfig, schema)` (R24, raw),
   `checkRequiredTogether(rawConfig, requiredTogetherGroups)` (R25, raw),
   `checkMutuallyExclusive(rawConfig, mutuallyExclusiveGroups)` (R26, raw),
   `checkRequiredIf(rawConfig, schema)` (R29, raw). (R27's
   `checkUnknownKeys` is deliberately **not** included here — it stays
   opt-in, called on its own, e.g. by R49's `--strict`.)
4. Concatenate all nine checks' errors in the order listed above, then sort
   the combined list by path with a stable sort (so two errors on the same
   path keep the order they were concatenated in). If the combined list is
   empty, return `{ ok: true, value: typed.value }`; otherwise
   `{ ok: false, stage: 'constraints', errors: combinedList }`.

The `stage` field is what tells a caller (R44's CLI) whether a failure was a
basic type/required problem or a constraint problem, without re-running any
check twice.

### Provenance: which layer won, and why

## R33 — trace which layer set each key

`src/provenance.js` exports `traceLayers(layers, names)`.

`layers` is an array of configs (R1's shape), `names` an equal-length array
of strings naming each layer. Pure function. Returns a plain object: every
dotted path (R11's `joinPath`) that is set in at least one layer, mapped to
`{ value, layer }` — the value from the **last** layer that set it, and that
layer's name. A path's position in the returned object is its first
insertion order (walking `layers` in order, and within each layer its own
section/key order) — only the `value`/`layer` update on a later hit, per
normal JS object semantics.

```js
traceLayers(
  [{ server: { host: 'a' } }, { server: { host: 'b', port: '9' } }],
  ['file', 'flags'],
)
// { 'server.host': { value: 'b', layer: 'flags' }, 'server.port': { value: '9', layer: 'flags' } }
```

## R34 — print the trace

`src/provenance.js` also exports `formatProvenance(trace)`.

Takes R33's output. One line per path, sorted by path (R2's compare):
`` <path> = <value> (<layer>) ``, joined by `\n`, no trailing newline. Empty
input gives an empty string.

```js
formatProvenance({ 'server.host': { value: 'b', layer: 'flags' } })
// 'server.host = b (flags)'
```

### More output formats

## R35 — a dotenv-style report

`src/format.js` exports `toDotenv(value)`.

Pure. Walks `value` (R2's shape), sections sorted, keys within a section
sorted (both by R2's plain string compare). For each, emits
`` <SECTION>_<KEY>=<value> `` (section and key upper-cased, joined by `_`;
section `''` is omitted along with its underscore, so the line is just
`<KEY>=<value>`). Every value prints via plain `String()` — a boolean or
number that way, and an array (from a `list`/`list<...>` path, R13–R15)
that way too, which joins its items with `,`, the same format R13 reads
raw text in. Lines joined by `\n`, no trailing newline.

```js
toDotenv({ '': { verbose: 'true' }, server: { host: 'localhost', port: '9' } })
// 'VERBOSE=true\nSERVER_HOST=localhost\nSERVER_PORT=9'
```

## R36 — a flat `path=value` report

`src/format.js` also exports `toFlat(value)`.

Same walk and sort as R35, but each line is `` <path>=<value> `` using R11's
`joinPath` for the path (no case change, no underscore-joining). Joined by
`\n`, no trailing newline.

```js
toFlat({ '': { verbose: 'true' }, server: { host: 'localhost' } })
// 'verbose=true\nserver.host=localhost'
```

### Quoted values

## R37 — unquote one value

`src/quotes.js` exports `unquote(value)`.

Pure. If `value` starts and ends with `"` (and has length 2 or more): take
the text between the two outer quotes, and replace every two-character
sequence `\"` with a single `"` — that is the **only** escape this format
has. A lone `\` before anything else (including another `\`) is left exactly
as it is; this function never treats `\\` as an escaped backslash. That
keeps the rule a single, unambiguous find-and-replace, not a left-to-right
scan someone has to invent. If `value` does not start and end with `"`,
return it unchanged.

```js
unquote('"a,b"')            // 'a,b'
unquote('a,b')               // 'a,b'  (unchanged, not quoted)
unquote('"say \\"hi\\""')    // 'say "hi"'  (replacing every \" with " in `say \"hi\"`)
```

## R38 — unquote a whole config

`src/values.js` exports `unquoteConfig(config)`.

Pure. Returns a new config (R1's shape, never mutates the input) where every
leaf string value has been run through R37's `unquote`.

```js
unquoteConfig({ a: { x: '"1,2"' } })   // { a: { x: '1,2' } }
```

### Diffing and summarizing

## R39 — diff two resolved values

`src/diff.js` exports `diffResolved(a, b)`.

Pure. `a` and `b` are any two plain nested configs (any shape R1/R2 can
produce, raw or coerced — this function just compares values, not types).
Two leaf values count as the same if `JSON.stringify(x) === JSON.stringify(y)`
— exact for the strings/numbers/booleans/arrays-of-those that ever appear at
a leaf here, and it sidesteps object-identity questions for array values
(two separately-built arrays with the same items count as equal). Returns an
array of `{ path, before, after }` for every dotted path (R11's `joinPath`)
present in `a` or `b` where the value differs by that rule — `before` is
`undefined` when a path is new in `b`, `after` is `undefined` when a path was
removed. Sorted by path.

```js
diffResolved({ a: { x: 1 } }, { a: { x: 2, y: 3 } })
// [{ path: 'a.x', before: 1, after: 2 }, { path: 'a.y', before: undefined, after: 3 }]
```

## R40 — print a diff

`src/diff.js` also exports `formatDiff(diffs)`.

Takes R39's array as-is (already sorted). One line per entry:
`` <path>: <before> -> <after> `` (the literal text `undefined` for a missing
side), joined by `\n`. Empty array gives an empty string.

## R41 — summarize an error list

`src/summary.js` exports `summarizeErrors(errors)`.

Pure. `errors` is any array of `{ path, message }` (the shape used
throughout R2 onward). Returns `{ count, paths }`: `count` is `errors.length`;
`paths` is the sorted, de-duplicated list of every distinct `path` (R2's
compare).

```js
summarizeErrors([{ path: 'a.x', message: 'is required' }, { path: 'a.x', message: 'must be a number' }])
// { count: 2, paths: ['a.x'] }
```

## R42 — print a summary

`src/summary.js` also exports `formatSummary({ count, paths })`.

If `count` is `0`, returns exactly `no errors`. Otherwise returns
`` `${count} error(s) across ${paths.length} path(s): ${paths.join(', ')}` ``.

```js
formatSummary({ count: 2, paths: ['a.x', 'b.y'] })
// '2 error(s) across 2 path(s): a.x, b.y'
formatSummary({ count: 0, paths: [] })   // 'no errors'
```

### A second CLI: `bin/polyctl.js`

## R43 — the extended schema

`bin/polyctl.js` is a new, second entry point, independent of R9/R10's
`bin/cli.js` (which stays exactly as R9/R10 left it — nothing below touches
it). It always validates against this fixed schema, `EXT_SCHEMA`, plus two
fixed group lists, `EXT_REQUIRED_TOGETHER` and `EXT_MUTUALLY_EXCLUSIVE`,
whatever the config holds:

| path | type | required | default | extra rules |
|---|---|---|---|---|
| `server.port` | integer | yes | — | `min: 1, max: 65535` |
| `server.host` | string | no | `localhost` | `minLength: 1, maxLength: 255` |
| `server.mode` | string | no | `production` | `oneOf: ['development', 'staging', 'production']` |
| `server.tag` | string | no | — | `` pattern: '^[a-z][a-z0-9-]*$' `` |
| `server.aliases` | list | no | — | `minItems: 0, maxItems: 5, unique: true` |
| `db.user` | string | no | — | in `EXT_REQUIRED_TOGETHER` with `db.pass`, and in `EXT_MUTUALLY_EXCLUSIVE` with `db.url` |
| `db.pass` | string | no | — | in `EXT_REQUIRED_TOGETHER` with `db.user` |
| `db.url` | string | no | — | in `EXT_MUTUALLY_EXCLUSIVE` with `db.user` |
| `db.replica` | string | no | — | `requiredIf: { path: 'db.url', equals: 'cluster' }` |

`EXT_REQUIRED_TOGETHER = [['db.user', 'db.pass']]`,
`EXT_MUTUALLY_EXCLUSIVE = [['db.url', 'db.user']]`.

This is spec text only here — R44 wires it up.

## R44 — the `resolve` subcommand, and the shared pipeline

```
node bin/polyctl.js resolve <path> [flags...]
```

Every subcommand below (`resolve`, and R45/R47/R48's `check`/`explain`/
`report`) shares this exact pipeline and exit-code contract; they differ only
in what they print to stdout on success.

`process.argv.slice(2)` is `[subcommand, path, ...flags]`.

0. If it is empty, exit `64`. Otherwise, if the first element is not exactly
   one of `resolve`, `check`, `explain`, `report`, exit `65`, stderr is
   `` unknown subcommand: <it>\n ``. Otherwise `<path>` is the second element
   and `[flags...]` is everything after it.

`--format` takes its value only as `--format=<name>`, joined by an equals
sign. The two-argument form `--format <name>` is not supported anywhere, and
neither is any other control flag below: a value never arrives as the next
argument.

**Every control flag any requirement from here on introduces —**
`--json`, `--format` (and its `=<name>`), `--strict`, `--summary`, `--diff`,
`--quiet`, `--full` **— is filtered out of `[flags...]` before it reaches
`parseFlags`/`resolveLayers`**, the same way R10 filters `--json` out on
`bin/cli.js`. Without this, e.g. `--strict` would itself be parsed by R5 as
a plain flag and land in the resolved config as `''.strict`. None of these
flags are ever config keys and none ever appear in a resolved value.

1. If no `<path>` was given, exit `64`. Nothing is printed.
2. Read `<path>` with `readFileSync` (utf-8). If that throws, or `parseIni`
   (R1) throws, or R18's `resolveIncludes` throws (no include files are
   wired in yet at this requirement, so this only fires if a config sets
   `include=` to a name `resolveIncludes` doesn't have) — exit `2`, stderr is
   the error's `message` plus `\n`.
3. Otherwise build the raw, pre-validation config: `fromFile = parseIni(text)`
   (R1); `withIncludes = resolveIncludes(fromFile, {})` (R18, no include
   files yet); `fromEnv = envToConfig({}, 'POLYGON')` (R17, always empty at
   this requirement — R46 changes this one line); `fromFlags = parseFlags(flags).set`
   (R5); `defaultsLayer = defaultsAsLayer(EXT_SCHEMA)` (R19);
   `rawConfig = mergeLayers([defaultsLayer, withIncludes, fromEnv, fromFlags])` (R4).
4. `result = collectErrors({ rawConfig, schema: EXT_SCHEMA, requiredTogetherGroups: EXT_REQUIRED_TOGETHER, mutuallyExclusiveGroups: EXT_MUTUALLY_EXCLUSIVE })` (R32).
5. If `result.ok` is `false`: exit `3` when `result.stage === 'basic'`, exit
   `4` when `result.stage === 'constraints'`. Either way, stderr is
   `formatErrors(result.errors)` (R7) plus `\n`. Nothing on stdout.
6. If `result.ok` is `true`: exit `0`. For the `resolve` subcommand
   specifically: print nothing by default; with `--json` anywhere in the
   flags (same rule as R10), print `toJson(result.value)` (R8) plus `\n` to
   stdout and nothing else.

## R45 — the `check` subcommand

```
node bin/polyctl.js check <path> [flags...]
```

Exactly R44's shared pipeline and exit codes. On success (exit `0`), prints
nothing to stdout, ever — `--json` and any `--format` flag are ignored by
this subcommand. ("Silent" here is about stdout only: R58 still has this
subcommand print deprecation warnings to stderr.)

## R46 — read real environment variables, in one place only

Change one line of R44's step 3: `fromEnv = envToConfig(process.env, 'POLYGON')`.
This is the only place, in either CLI, that reads `process.env` — exactly as
R9's single `readFileSync` is the only file read. A test that wants a fixed
answer regardless of the host machine's real environment controls this the
same way it already controls argv: by passing an explicit `env` to the child
process it spawns, not by relying on what happens to be set.

## R47 — the `explain` subcommand

```
node bin/polyctl.js explain <path> [flags...]
```

Exactly R44's shared pipeline and exit codes. On success (exit `0`), print
R34's `formatProvenance` of R33's `traceLayers` over the same four layers
built in R44's step 3, named in order: `'defaults'`, `'file'`, `'env'`,
`'flags'` (`'file'` here means `withIncludes`, the file with any include
already folded in). Plus `\n`, nothing else on stdout.

## R48 — the `report` subcommand, and output formats

```
node bin/polyctl.js report <path> --format=<name> [flags...]
```

Exactly R44's shared pipeline and exit codes. On success (exit `0`), print
one of, plus `\n`, nothing else on stdout: `--format=json` →
`toJson(result.value)` (R8); `--format=dotenv` → `toDotenv(result.value)`
(R35); `--format=flat` → `toFlat(result.value)` (R36). No `--format` given
means `--format=json`.

## R49 — `--strict`

When `--strict` is present in the flags, on any subcommand, after step 4
succeeds (`result.ok === true`), also run
`checkUnknownKeys(rawConfig, EXT_SCHEMA)` (R27). If it finds any, exit `5`,
stderr is `formatErrors` of its errors plus `\n`, nothing on stdout — this
new exit code sits alongside R44's `0`/`2`/`3`/`4`/`64`. Without `--strict`,
unknown keys are silently ignored, same as R2 always did.

## R50 — `--summary`

When `--summary` is present in the flags, on any subcommand, on any of the
error exits that carry an `errors` array (`3`, `4`, `5` — not `2`, `64`, or
`65`, which are not that shape), print one more line to stderr, after the
`formatErrors` line: `formatSummary(summarizeErrors(errors))` (R41/R42) plus
`\n`. The exit code is unchanged.

## R51 — `report --diff`

On the `report` subcommand only, `--diff` replaces the normal `--format`
output. It compares two **raw** (pre-validation) configs built the same way
as R44's step 3: `before = mergeLayers([defaultsLayer, withIncludes, fromEnv])`
(everything except the flags layer) and `after = rawConfig` (with flags).
Prints `formatDiff(diffResolved(before, after))` (R39/R40) plus `\n` — this
shows exactly what the command-line flags changed, and needs no schema
resolution of its own, so it still works even when `before` alone would fail
validation.

## R52 — `--quiet`

When `--quiet` is present in the flags, on any error exit, suppress the
`formatErrors` (and R50's summary, if also requested) stderr output — the
exit code is unchanged, only the stderr text is dropped. Success output
(stdout) is never affected by `--quiet`.

### A fuller provenance report

## R53 — explain one path in one sentence

`src/provenance.js` also exports `explainWinner(trace, path)`.

Pure. `trace` is R33's output. If `path` is not a key of `trace`, returns
`` `${path} was never set` ``. Otherwise returns
`` `${path} = ${trace[path].value} (set by ${trace[path].layer})` `` — plain
ASCII parentheses, not a dash, so the string is unambiguous to type back out.

## R54 — the full layer history of every path

`src/provenance.js` also exports `tracedHistory(layers, names)`.

Pure, same inputs as R33. Unlike R33 (which keeps only the winner), this
keeps **every** layer that touched a path: returns an object mapping each
dotted path (R11's `joinPath`) to an array of `{ layer, value }`, one entry
per layer that set it, in layer order. Does not replace or change R33's
contract — a separate export, for when the full story is wanted, not just
the winner.

## R55 — print a layer history

`src/provenance.js` also exports `formatHistory(history)`.

Takes R54's output. One line per path, sorted by path:
`` <path>: <layer1>=<value1> -> <layer2>=<value2> -> ... ``, `\n`-joined.
Empty input gives an empty string.

## R56 — `explain --full`

On the `explain` subcommand (R47), when `--full` is present, print R55's
`formatHistory` of R54's `tracedHistory` instead of R47's `formatProvenance` —
same four layers, same names, same everything else about R47.

### Deprecation warnings

## R57 — flag a deprecated path

`src/rules.js` also exports `checkDeprecated(rawConfig, schema)`.

First, before looking at `rawConfig` at all: for every schema path whose
`deprecated` is a string, that string must itself be a key of `schema` — if
it is not, throw a `TypeError` whose message is
`` unknown replacement path: <that string> ``. This is part of this same
function, not a separate one — a schema-authoring mistake, checked once per
call, regardless of what `rawConfig` holds.

Then, for every schema path where `deprecated` is truthy and the path is
present in `rawConfig`: push a warning `{ path, message }`. When
`deprecated` is a string, message is
`` is deprecated, use <deprecated> instead ``; when `deprecated` is `true`
(no replacement named), message is `is deprecated`. Returns `{ warnings }`
— always this shape, sorted by path; warnings never carry an `ok` field,
because they never fail a run.

## R58 — print warnings on every successful run

On every subcommand (`resolve`, `check`, `explain`, `report`), after step 6
of R44's pipeline succeeds (exit `0`): call
`checkDeprecated(rawConfig, EXT_SCHEMA)` (R57). If `.warnings.length > 0`,
print `formatErrors(warnings)` (R7 — the `{path, message}` shape matches)
plus `\n` to **stderr**, before the subcommand's own stdout output. The exit
code stays `0` regardless. This runs even for `check`, whose "silent" in R45
only ever meant stdout.

## R59 — a second deprecated path

`EXT_SCHEMA` (R43) gains another path:

| path | type | required | default | extra rules |
|---|---|---|---|---|
| `server.legacyHost` | string | no | — | `deprecated: 'server.host'` |

R57 already states that warnings are sorted by path and returned as one
array; R60 gives the exact worked example of what that means once there are
two.

## R60 — deprecated paths, end to end

`EXT_SCHEMA` (R43) gains one more path, alongside R59's:

| path | type | required | default | extra rules |
|---|---|---|---|---|
| `server.legacyPort` | integer | no | — | `deprecated: 'server.port'` |

Worked example: a config file with a valid `server.port` and also
`server.legacyHost = old.example.com` and `server.legacyPort = 9000` resolves
with exit `0` on every subcommand. `checkDeprecated` (R57) returns two
warnings, and R58 prints them, sorted by path (`legacyHost` before
`legacyPort` — `'H'` sorts before `'P'`), as one `formatErrors` call, to
stderr, exactly:

```
server.legacyHost: is deprecated, use server.host instead
server.legacyPort: is deprecated, use server.port instead
```

Stdout behavior is whatever the subcommand normally prints on success,
unchanged by any of this.
