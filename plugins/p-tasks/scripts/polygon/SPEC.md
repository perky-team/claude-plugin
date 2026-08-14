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
