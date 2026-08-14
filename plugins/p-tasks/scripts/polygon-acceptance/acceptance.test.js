import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
// The suite is copied into the ROOT of a snapshot before it runs, so every path
// here is `./`, never `../`. Getting this wrong makes every test fail on an
// import error and the whole study reads as "the agent built nothing".
import { parseIni } from './src/parse.js';
import { validate } from './src/schema.js';
import { applyDefaults } from './src/defaults.js';
import { mergeLayers } from './src/merge.js';
import { parseFlags } from './src/flags.js';
import { resolve } from './src/resolve.js';
import { formatErrors } from './src/errors.js';
import { toJson } from './src/report.js';
import { splitPath, joinPath } from './src/paths.js';
import { coerceExtraTypes } from './src/types.js';
import { envToConfig } from './src/env.js';
import { resolveIncludes } from './src/include.js';
import { defaultsAsLayer } from './src/defaultsLayer.js';
import { resolveLayers } from './src/pipeline.js';
import {
  checkRange,
  checkOneOf,
  checkPattern,
  checkRequiredTogether,
  checkMutuallyExclusive,
  checkUnknownKeys,
  checkLength,
  checkRequiredIf,
  checkListLength,
  checkUnique,
  checkDeprecated,
} from './src/rules.js';
import { collectErrors } from './src/aggregate.js';
import {
  traceLayers,
  formatProvenance,
  explainWinner,
  tracedHistory,
  formatHistory,
} from './src/provenance.js';
import { toDotenv, toFlat } from './src/format.js';
import { unquote } from './src/quotes.js';
import { unquoteConfig } from './src/values.js';
import { diffResolved, formatDiff } from './src/diff.js';
import { summarizeErrors, formatSummary } from './src/summary.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'cli.js');
const POLYCTL = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'polyctl.js');
const withFile = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'polygon-')), 'c.ini');
  writeFileSync(p, text);
  return p;
};
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });

// R46 makes `bin/polyctl.js` read `process.env`. Replacing the child's whole
// environment would strip PATH and SystemRoot and break node itself, so start
// from the host's environment, drop every POLYGON variable the operator's
// machine may already carry, and add back only what the test means to set.
// Without this a test passes on one computer and fails on another.
const CLEAN_ENV = (() => {
  const copy = { ...process.env };
  for (const name of Object.keys(copy)) {
    if (name.toUpperCase().startsWith('POLYGON')) delete copy[name];
  }
  return copy;
})();
const ctl = (args, extraEnv = {}) => spawnSync(process.execPath, [POLYCTL, ...args],
  { encoding: 'utf-8', env: { ...CLEAN_ENV, ...extraEnv } });

// ---------------------------------------------------------------------------
// R1 — parse an INI file
// ---------------------------------------------------------------------------

test('R1 keeps keys before any section under the empty name', () => {
  assert.deepEqual(parseIni('x = 1\n'), { '': { x: '1' } });
});

test('R1 counts the line number from one', () => {
  assert.throws(() => parseIni('# ok\n\n???\n'), { message: 'line 3: ???' });
});

test('R1 throws a SyntaxError on a line it cannot read', () => {
  assert.throws(() => parseIni('???\n'), SyntaxError);
});

// ---------------------------------------------------------------------------
// R2 — check a value against a schema
// ---------------------------------------------------------------------------

test('R2 sorts errors by path', () => {
  const schema = { 'b.y': { type: 'number' }, 'a.x': { type: 'boolean' } };
  const r = validate({ a: { x: 'yes' }, b: { y: 'no' } }, schema);
  assert.deepEqual(r.errors.map((e) => e.path), ['a.x', 'b.y']);
});

test('R2 refuses an empty string as a number', () => {
  const r = validate({ a: { x: '' } }, { 'a.x': { type: 'number' } });
  assert.deepEqual(r.errors, [{ path: 'a.x', message: 'must be a number' }]);
});

test('R2 turns the strings true and false into booleans', () => {
  const schema = { 'a.x': { type: 'boolean' }, 'a.y': { type: 'boolean' } };
  const r = validate({ a: { x: 'true', y: 'false' } }, schema);
  assert.deepEqual(r, { ok: true, value: { a: { x: true, y: false } } });
});

test('R2 says must be true or false for any other boolean value', () => {
  const r = validate({ a: { x: 'yes' } }, { 'a.x': { type: 'boolean' } });
  assert.deepEqual(r, { ok: false, errors: [{ path: 'a.x', message: 'must be true or false' }] });
});

test('R2 leaves out a key the schema does not name', () => {
  const r = validate({ a: { x: '1' }, b: { y: '2' } }, { 'a.x': { type: 'string' } });
  assert.deepEqual(r, { ok: true, value: { a: { x: '1' } } });
});

// ---------------------------------------------------------------------------
// R3 — fill in defaults
// ---------------------------------------------------------------------------

test('R3 does not change its input', () => {
  const input = { a: {} };
  applyDefaults(input, { 'a.x': { type: 'string', default: 'd' } });
  assert.deepEqual(input, { a: {} });
});

test('R3 writes a number default as a string', () => {
  assert.deepEqual(applyDefaults({}, { 'a.x': { type: 'number', default: 1 } }), { a: { x: '1' } });
});

test('R3 leaves a value that is already there', () => {
  const out = applyDefaults({ a: { x: '5' } }, { 'a.x': { type: 'number', default: 1 } });
  assert.deepEqual(out, { a: { x: '5' } });
});

// ---------------------------------------------------------------------------
// R4 — merge layers
// ---------------------------------------------------------------------------

test('R4 lets the later layer win key by key', () => {
  const out = mergeLayers([{ a: { x: '1', y: '2' } }, { a: { y: '3' } }]);
  assert.deepEqual(out, { a: { x: '1', y: '3' } });
});

test('R4 keeps a section only one layer has', () => {
  const out = mergeLayers([{ a: { x: '1' } }, { b: { y: '2' } }]);
  assert.deepEqual(out, { a: { x: '1' }, b: { y: '2' } });
});

test('R4 does not change its inputs', () => {
  const first = { a: { x: '1' } };
  const second = { a: { x: '2' } };
  mergeLayers([first, second]);
  assert.deepEqual(first, { a: { x: '1' } });
  assert.deepEqual(second, { a: { x: '2' } });
});

// ---------------------------------------------------------------------------
// R5 — parse command-line flags
// ---------------------------------------------------------------------------

test('R5 reads a flag and its value joined by an equals sign', () => {
  assert.deepEqual(parseFlags(['--a.x=1']), { set: { a: { x: '1' } }, rest: [] });
});

test('R5 reads a flag and its value as two arguments', () => {
  assert.deepEqual(parseFlags(['--a.x', '1']), { set: { a: { x: '1' } }, rest: [] });
});

test('R5 puts everything else in rest, in order', () => {
  assert.deepEqual(parseFlags(['one', '--a.x', '1', 'two']).rest, ['one', 'two']);
});

test('R5 sets a flag on its own to true in the empty section', () => {
  assert.deepEqual(parseFlags(['--v']), { set: { '': { v: 'true' } }, rest: [] });
});

// ---------------------------------------------------------------------------
// R6 — resolve everything
// ---------------------------------------------------------------------------

test('R6 lets a flag beat the file', () => {
  const r = resolve({
    text: '[a]\nx = 1\n', argv: ['--a.x=9'], schema: { 'a.x': { type: 'number' } },
  });
  assert.deepEqual(r, { ok: true, value: { a: { x: 9 } } });
});

test('R6 fills a default the file left out', () => {
  const r = resolve({
    text: '', argv: [], schema: { 'a.x': { type: 'number', default: 7 } },
  });
  assert.deepEqual(r, { ok: true, value: { a: { x: 7 } } });
});

test('R6 returns the same failure validate returns', () => {
  const r = resolve({
    text: '', argv: [], schema: { 'a.x': { type: 'string', required: true } },
  });
  assert.deepEqual(r, { ok: false, errors: [{ path: 'a.x', message: 'is required' }] });
});

// ---------------------------------------------------------------------------
// R7 — format errors
// ---------------------------------------------------------------------------

test('R7 writes one line per error', () => {
  const out = formatErrors([{ path: 'a.x', message: 'is required' },
    { path: 'b.y', message: 'must be a number' }]);
  assert.equal(out, 'a.x: is required\nb.y: must be a number');
});

test('R7 gives an empty string for an empty array', () => {
  assert.equal(formatErrors([]), '');
});

test('R7 keeps the errors in the order it was given', () => {
  const out = formatErrors([{ path: 'b.y', message: 'must be a number' },
    { path: 'a.x', message: 'is required' }]);
  assert.equal(out, 'b.y: must be a number\na.x: is required');
});

// ---------------------------------------------------------------------------
// R8 — print as JSON
// ---------------------------------------------------------------------------

test('R8 sorts keys at every level', () => {
  assert.equal(toJson({ b: 1, a: { d: 2, c: 3 } }),
    '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}');
});

test('R8 indents by two spaces and adds no trailing newline', () => {
  assert.equal(toJson({ a: { x: '1' } }), '{\n  "a": {\n    "x": "1"\n  }\n}');
});

// ---------------------------------------------------------------------------
// R9 — CLI exit codes
// ---------------------------------------------------------------------------

// A config the fixed schema in R9 accepts, with nothing left to a default.
const FULL = '[server]\nport = 8080\nhost = example.com\ndebug = true\n';

test('R9 exits 64 when no config path is given', () => {
  assert.equal(run([]).status, 64);
});

test('R9 exits 2 on a file it cannot parse', () => {
  assert.equal(run([withFile('???\n')]).status, 2);
});

test('R9 exits 0 on a config the fixed schema accepts', () => {
  assert.equal(run([withFile(FULL)]).status, 0);
});

test('R9 exits 3 when the required server.port is missing', () => {
  assert.equal(run([withFile('[server]\nhost = example.com\n')]).status, 3);
});

test('R9 exits 3 when server.port is not a number', () => {
  assert.equal(run([withFile('[server]\nport = abc\n')]).status, 3);
});

test('R9 prints the parse error to stderr', () => {
  const r = run([withFile('???\n')]);
  assert.match(r.stderr, /line 1: \?\?\?/);
});

test('R9 prints the validation errors to stderr', () => {
  const r = run([withFile('[server]\nhost = example.com\n')]);
  assert.match(r.stderr, /server\.port: is required/);
});

// ---------------------------------------------------------------------------
// R10 — `--json`
// ---------------------------------------------------------------------------

test('R10 prints only the paths the schema names', () => {
  const r = run([withFile(`${FULL}[other]\nz = 1\n`), '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { server: { port: 8080, host: 'example.com', debug: true } });
});

test('R10 reads a flag that comes after --json', () => {
  const r = run([withFile(FULL), '--json', '--server.host=flag.example']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { server: { port: 8080, host: 'flag.example', debug: true } });
});

test('R10 shows a default the config left out', () => {
  const r = run([withFile('[server]\nport = 8080\n'), '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { server: { port: 8080, host: 'localhost', debug: false } });
});

test('R10 prints the JSON sorted and indented', () => {
  const r = run([withFile(FULL), '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trimEnd(),
    '{\n  "server": {\n    "debug": true,\n    "host": "example.com",\n    "port": 8080\n  }\n}');
});

// ---------------------------------------------------------------------------
// R11 — split a path on its last dot
// ---------------------------------------------------------------------------

test('R11 splits a path on its LAST dot, so a dotted section stays whole', () => {
  assert.deepEqual(splitPath('server.tls.cert'), ['server.tls', 'cert']);
});

test('R11 splits a one-dot path into a section and a key', () => {
  assert.deepEqual(splitPath('server.port'), ['server', 'port']);
});

test('R11 throws a TypeError naming a path with no dot', () => {
  assert.throws(() => splitPath('port'), { name: 'TypeError', message: 'bad path: port' });
});

test('R11 joins a section and a key with a dot', () => {
  assert.equal(joinPath('server.tls', 'cert'), 'server.tls.cert');
});

test('R11 leaves out the dot when the section is empty', () => {
  assert.equal(joinPath('', 'verbose'), 'verbose');
});

// ---------------------------------------------------------------------------
// R12 — an `integer` type
// ---------------------------------------------------------------------------

test('R12 turns a digit string on an integer path into a number', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '3' } }, { 'a.x': { type: 'integer' } }),
    { ok: true, value: { a: { x: 3 } } });
});

test('R12 refuses a value with a fraction on an integer path', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '3.5' } }, { 'a.x': { type: 'integer' } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be an integer' }] });
});

test('R12 accepts a leading minus on an integer path', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '-7' } }, { 'a.x': { type: 'integer' } }),
    { ok: true, value: { a: { x: -7 } } });
});

test('R12 copies a path of another type over unchanged', () => {
  const schema = { 'a.x': { type: 'integer' }, 'a.y': { type: 'string' } };
  assert.deepEqual(coerceExtraTypes({ a: { x: '3', y: 'keep' } }, schema),
    { ok: true, value: { a: { x: 3, y: 'keep' } } });
});

test('R12 leaves out an integer path the value does not hold', () => {
  assert.deepEqual(coerceExtraTypes({}, { 'a.x': { type: 'integer' } }),
    { ok: true, value: {} });
});

test('R12 sorts its errors by path', () => {
  const schema = { 'b.y': { type: 'integer' }, 'a.x': { type: 'integer' } };
  const r = coerceExtraTypes({ a: { x: 'p' }, b: { y: 'q' } }, schema);
  assert.deepEqual(r.errors.map((e) => e.path), ['a.x', 'b.y']);
});

// ---------------------------------------------------------------------------
// R13 — a `list` type
// ---------------------------------------------------------------------------

test('R13 splits a list on commas and trims every piece', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: 'foo, bar ,baz' } }, { 'a.x': { type: 'list' } }),
    { ok: true, value: { a: { x: ['foo', 'bar', 'baz'] } } });
});

test('R13 reads the empty string as an empty list, not a one-item list', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '' } }, { 'a.x': { type: 'list' } }),
    { ok: true, value: { a: { x: [] } } });
});

test('R13 never fails to coerce a list', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: 'solo' } }, { 'a.x': { type: 'list' } }),
    { ok: true, value: { a: { x: ['solo'] } } });
});

// ---------------------------------------------------------------------------
// R14 — a `list<integer>` type
// ---------------------------------------------------------------------------

test('R14 turns every piece of a list<integer> into a number', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '1, 2, 3' } }, { 'a.x': { type: 'list<integer>' } }),
    { ok: true, value: { a: { x: [1, 2, 3] } } });
});

test('R14 gives ONE error for the whole path when a piece is not an integer', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '1, x, 3' } }, { 'a.x': { type: 'list<integer>' } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be a list of integers' }] });
});

test('R14 accepts a leading minus on a list<integer> piece', () => {
  assert.deepEqual(coerceExtraTypes({ a: { x: '-1, 2' } }, { 'a.x': { type: 'list<integer>' } }),
    { ok: true, value: { a: { x: [-1, 2] } } });
});

// ---------------------------------------------------------------------------
// R15 — a `list<boolean>` type
// ---------------------------------------------------------------------------

test('R15 turns every piece of a list<boolean> into a boolean', () => {
  const schema = { 'a.x': { type: 'list<boolean>' } };
  assert.deepEqual(coerceExtraTypes({ a: { x: 'true, false, true' } }, schema),
    { ok: true, value: { a: { x: [true, false, true] } } });
});

test('R15 gives ONE error for the whole path when a piece is not true or false', () => {
  const schema = { 'a.x': { type: 'list<boolean>' } };
  assert.deepEqual(coerceExtraTypes({ a: { x: 'true, yes' } }, schema),
    { ok: false, errors: [{ path: 'a.x', message: 'must be a list of true/false values' }] });
});

test('R15 reports one error per bad path, never per item, sorted by path', () => {
  const schema = { 'b.y': { type: 'list<boolean>' }, 'a.x': { type: 'list<integer>' } };
  assert.deepEqual(coerceExtraTypes({ a: { x: 'p, q' }, b: { y: 'yes, no' } }, schema), {
    ok: false,
    errors: [
      { path: 'a.x', message: 'must be a list of integers' },
      { path: 'b.y', message: 'must be a list of true/false values' },
    ],
  });
});

// ---------------------------------------------------------------------------
// R16 — a default for a `list`-typed path
// ---------------------------------------------------------------------------

test('R16 writes an array default as the comma-joined string String() gives', () => {
  assert.deepEqual(applyDefaults({}, { 'a.tags': { type: 'list', default: ['x', 'y'] } }),
    { a: { tags: 'x,y' } });
});

test('R16 reads that filled-in string back as the original list', () => {
  const schema = { 'a.tags': { type: 'list', default: ['x', 'y'] } };
  assert.deepEqual(coerceExtraTypes({ a: { tags: 'x,y' } }, schema),
    { ok: true, value: { a: { tags: ['x', 'y'] } } });
});

// ---------------------------------------------------------------------------
// R17 — an environment-variable layer
// ---------------------------------------------------------------------------

test('R17 reads prefix, two underscores, section, two underscores, key', () => {
  assert.deepEqual(envToConfig({ APP__server__port: '9', OTHER: 'x' }, 'APP'),
    { server: { port: '9' } });
});

test('R17 ignores a key whose remainder holds no second double underscore', () => {
  assert.deepEqual(envToConfig({ APP__port: '9' }, 'APP'), {});
});

test('R17 keeps the case of the section and the key exactly', () => {
  assert.deepEqual(envToConfig({ APP__Server__Port: '9' }, 'APP'), { Server: { Port: '9' } });
});

test('R17 splits on the FIRST remaining double underscore', () => {
  assert.deepEqual(envToConfig({ APP__a__b__c: '1' }, 'APP'), { a: { b__c: '1' } });
});

test('R17 turns the value into a string', () => {
  assert.deepEqual(envToConfig({ APP__a__b: 9 }, 'APP'), { a: { b: '9' } });
});

// ---------------------------------------------------------------------------
// R18 — an include-by-name layer
// ---------------------------------------------------------------------------

test('R18 folds the included file in UNDER the config that named it', () => {
  const out = resolveIncludes(
    { '': { include: 'base.ini' }, server: { port: '9' } },
    { 'base.ini': '[server]\nhost = example.com\n' },
  );
  assert.deepEqual(out, { server: { host: 'example.com', port: '9' } });
});

test('R18 lets the including config override the included one key by key', () => {
  const out = resolveIncludes(
    { '': { include: 'base.ini' }, server: { port: '9' } },
    { 'base.ini': '[server]\nport = 1\n' },
  );
  assert.deepEqual(out, { server: { port: '9' } });
});

test('R18 drops the include key but keeps the rest of the empty section', () => {
  const out = resolveIncludes(
    { '': { include: 'base.ini', verbose: 'true' } },
    { 'base.ini': '[server]\nhost = example.com\n' },
  );
  assert.deepEqual(out, { '': { verbose: 'true' }, server: { host: 'example.com' } });
});

test('R18 throws a SyntaxError naming a file it was not given', () => {
  assert.throws(() => resolveIncludes({ '': { include: 'gone.ini' } }, {}),
    { name: 'SyntaxError', message: 'no such include: gone.ini' });
});

test('R18 returns a copy when no include is set', () => {
  const input = { server: { port: '9' } };
  const out = resolveIncludes(input, {});
  assert.deepEqual(out, { server: { port: '9' } });
  assert.notEqual(out, input);
});

// ---------------------------------------------------------------------------
// R19 — schema defaults as a layer
// ---------------------------------------------------------------------------

test('R19 turns a schema default into a plain config entry', () => {
  assert.deepEqual(defaultsAsLayer({ 'server.host': { type: 'string', default: 'localhost' } }),
    { server: { host: 'localhost' } });
});

test('R19 leaves out a schema path that has no default', () => {
  const schema = { 'a.x': { type: 'string' }, 'a.y': { type: 'string', default: 'd' } };
  assert.deepEqual(defaultsAsLayer(schema), { a: { y: 'd' } });
});

test('R19 writes a number default as a string, the same way R3 does', () => {
  assert.deepEqual(defaultsAsLayer({ 'a.n': { type: 'number', default: 1 } }), { a: { n: '1' } });
});

// ---------------------------------------------------------------------------
// R20 — resolve with layers, named
// ---------------------------------------------------------------------------

const LAYER_SCHEMA = {
  'server.port': { type: 'integer', required: true },
  'server.host': { type: 'string' },
};

test('R20 runs the whole layered pipeline and coerces the extra types', () => {
  const r = resolveLayers({
    text: '[server]\nport = 9\n',
    argv: ['--server.host=x'],
    env: {},
    envPrefix: 'APP',
    includeFiles: {},
    schema: LAYER_SCHEMA,
  });
  assert.deepEqual(r, { ok: true, value: { server: { port: 9, host: 'x' } } });
});

test('R20 lets the env layer beat the file layer', () => {
  const r = resolveLayers({
    text: '[server]\nport = 1\n',
    argv: [],
    env: { APP__server__port: '2' },
    envPrefix: 'APP',
    includeFiles: {},
    schema: LAYER_SCHEMA,
  });
  assert.deepEqual(r, { ok: true, value: { server: { port: 2 } } });
});

test('R20 lets the flags layer beat the env layer', () => {
  const r = resolveLayers({
    text: '[server]\nport = 1\n',
    argv: ['--server.port=3'],
    env: { APP__server__port: '2' },
    envPrefix: 'APP',
    includeFiles: {},
    schema: LAYER_SCHEMA,
  });
  assert.deepEqual(r, { ok: true, value: { server: { port: 3 } } });
});

test('R20 puts the defaults layer lowest of all', () => {
  const r = resolveLayers({
    text: '',
    argv: [],
    env: {},
    envPrefix: 'APP',
    includeFiles: {},
    schema: { 'server.host': { type: 'string', default: 'localhost' } },
  });
  assert.deepEqual(r, { ok: true, value: { server: { host: 'localhost' } } });
});

test('R20 folds an include into the file layer', () => {
  const r = resolveLayers({
    text: 'include = base.ini\n[server]\nport = 1\n',
    argv: [],
    env: {},
    envPrefix: 'APP',
    includeFiles: { 'base.ini': '[server]\nhost = h\n' },
    schema: LAYER_SCHEMA,
  });
  assert.deepEqual(r, { ok: true, value: { server: { port: 1, host: 'h' } } });
});

test('R20 hands back the failure validate gave it, unchanged', () => {
  const r = resolveLayers({
    text: '',
    argv: [],
    env: {},
    envPrefix: 'APP',
    includeFiles: {},
    schema: LAYER_SCHEMA,
  });
  assert.deepEqual(r, { ok: false, errors: [{ path: 'server.port', message: 'is required' }] });
});

// ---------------------------------------------------------------------------
// R21 — a list is replaced whole, never appended
// ---------------------------------------------------------------------------

test('R21 lets a flag replace the file list whole, never appending to it', () => {
  const r = resolveLayers({
    text: '[db]\nhosts = a,b,c\n',
    argv: ['--db.hosts=x,y'],
    env: {},
    envPrefix: 'APP',
    includeFiles: {},
    schema: { 'db.hosts': { type: 'list' } },
  });
  assert.deepEqual(r, { ok: true, value: { db: { hosts: ['x', 'y'] } } });
});

test('R21 leaves nothing of a longer file list behind', () => {
  const r = resolveLayers({
    text: '[db]\nhosts = a,b,c,d\n',
    argv: ['--db.hosts=x'],
    env: {},
    envPrefix: 'APP',
    includeFiles: {},
    schema: { 'db.hosts': { type: 'list' } },
  });
  assert.deepEqual(r.value.db.hosts, ['x']);
});

// ---------------------------------------------------------------------------
// R22 — minimum and maximum
// ---------------------------------------------------------------------------

test('R22 says nothing when the value sits inside the range', () => {
  assert.deepEqual(checkRange({ a: { x: 5 } }, { 'a.x': { type: 'number', min: 1, max: 10 } }),
    { ok: true });
});

test('R22 reports a value below the minimum', () => {
  assert.deepEqual(checkRange({ a: { x: 0 } }, { 'a.x': { type: 'number', min: 1 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be at least 1' }] });
});

test('R22 reports a value above the maximum', () => {
  assert.deepEqual(checkRange({ a: { x: 11 } }, { 'a.x': { type: 'integer', max: 10 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be at most 10' }] });
});

test('R22 gives at most one range error per path, checking min first', () => {
  assert.deepEqual(checkRange({ a: { x: 5 } }, { 'a.x': { type: 'number', min: 10, max: 1 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be at least 10' }] });
});

test('R22 ignores a path the value does not hold', () => {
  assert.deepEqual(checkRange({}, { 'a.x': { type: 'number', min: 1, max: 10 } }), { ok: true });
});

// ---------------------------------------------------------------------------
// R23 — one of a fixed set of values
// ---------------------------------------------------------------------------

test('R23 says nothing when the raw value is one of the allowed ones', () => {
  assert.deepEqual(checkOneOf({ a: { x: 'b' } }, { 'a.x': { oneOf: ['a', 'b'] } }), { ok: true });
});

test('R23 lists the allowed values in the order the schema gives them', () => {
  assert.deepEqual(checkOneOf({ a: { x: 'c' } }, { 'a.x': { oneOf: ['b', 'a'] } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be one of b, a' }] });
});

test('R23 ignores a path the config does not set', () => {
  assert.deepEqual(checkOneOf({}, { 'a.x': { oneOf: ['a'] } }), { ok: true });
});

// ---------------------------------------------------------------------------
// R24 — a pattern
// ---------------------------------------------------------------------------

test('R24 says nothing when the raw value matches the pattern', () => {
  assert.deepEqual(checkPattern({ a: { x: 'abc' } }, { 'a.x': { pattern: '^[a-z]+$' } }),
    { ok: true });
});

test('R24 quotes the pattern exactly as written in the message', () => {
  assert.deepEqual(checkPattern({ a: { x: 'A1' } }, { 'a.x': { pattern: '^[a-z]+$' } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must match ^[a-z]+$' }] });
});

test('R24 does not anchor the pattern for you', () => {
  assert.deepEqual(checkPattern({ a: { x: 'abc' } }, { 'a.x': { pattern: 'b' } }), { ok: true });
});

// ---------------------------------------------------------------------------
// R25 — required together
// ---------------------------------------------------------------------------

test('R25 asks for the missing partner when one of a group is set', () => {
  assert.deepEqual(checkRequiredTogether({ db: { user: 'a' } }, [['db.user', 'db.pass']]),
    { ok: false, errors: [{ path: 'db.pass', message: 'must be set together with db.user' }] });
});

test('R25 says nothing when none of a group is set', () => {
  assert.deepEqual(checkRequiredTogether({}, [['db.user', 'db.pass']]), { ok: true });
});

test('R25 says nothing when the whole group is set', () => {
  assert.deepEqual(checkRequiredTogether({ db: { user: 'a', pass: 'b' } },
    [['db.user', 'db.pass']]), { ok: true });
});

test('R25 names every other path of the group, in group order, leaving itself out', () => {
  assert.deepEqual(checkRequiredTogether({ a: { y: '1' } }, [['a.x', 'a.y', 'a.z']]), {
    ok: false,
    errors: [
      { path: 'a.x', message: 'must be set together with a.y, a.z' },
      { path: 'a.z', message: 'must be set together with a.x, a.y' },
    ],
  });
});

// ---------------------------------------------------------------------------
// R26 — mutually exclusive
// ---------------------------------------------------------------------------

test('R26 says nothing when only one path of a group is set', () => {
  assert.deepEqual(checkMutuallyExclusive({ db: { url: 'u' } }, [['db.url', 'db.user']]),
    { ok: true });
});

test('R26 gives every present path an error when two are set', () => {
  assert.deepEqual(checkMutuallyExclusive({ db: { url: 'u', user: 'a' } },
    [['db.url', 'db.user']]), {
    ok: false,
    errors: [
      { path: 'db.url', message: 'cannot be set together with db.user' },
      { path: 'db.user', message: 'cannot be set together with db.url' },
    ],
  });
});

test('R26 names only the paths actually set, not the whole group', () => {
  assert.deepEqual(checkMutuallyExclusive({ a: { x: '1', z: '3' } }, [['a.x', 'a.y', 'a.z']]), {
    ok: false,
    errors: [
      { path: 'a.x', message: 'cannot be set together with a.z' },
      { path: 'a.z', message: 'cannot be set together with a.x' },
    ],
  });
});

// ---------------------------------------------------------------------------
// R27 — unknown keys (strict mode)
// ---------------------------------------------------------------------------

test('R27 reports a path the schema does not name', () => {
  assert.deepEqual(checkUnknownKeys({ a: { x: '1' } }, {}),
    { ok: false, errors: [{ path: 'a.x', message: 'unknown key' }] });
});

test('R27 says nothing when every key is in the schema', () => {
  assert.deepEqual(checkUnknownKeys({ a: { x: '1' } }, { 'a.x': { type: 'string' } }), { ok: true });
});

test('R27 builds a bare path for a key with no section', () => {
  assert.deepEqual(checkUnknownKeys({ '': { v: '1' } }, {}),
    { ok: false, errors: [{ path: 'v', message: 'unknown key' }] });
});

// ---------------------------------------------------------------------------
// R28 — string length
// ---------------------------------------------------------------------------

test('R28 reports a string shorter than minLength', () => {
  assert.deepEqual(checkLength({ a: { x: '' } }, { 'a.x': { type: 'string', minLength: 1 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be at least 1 characters' }] });
});

test('R28 reports a string longer than maxLength', () => {
  assert.deepEqual(checkLength({ a: { x: 'abc' } }, { 'a.x': { type: 'string', maxLength: 2 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be at most 2 characters' }] });
});

test('R28 checks a path whose type is not set at all', () => {
  assert.deepEqual(checkLength({ a: { x: 'abc' } }, { 'a.x': { maxLength: 2 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must be at most 2 characters' }] });
});

test('R28 ignores a path of any type other than string', () => {
  assert.deepEqual(checkLength({ a: { x: '12345' } }, { 'a.x': { type: 'integer', maxLength: 2 } }),
    { ok: true });
});

// ---------------------------------------------------------------------------
// R29 — required if another path has a value
// ---------------------------------------------------------------------------

const REQ_IF = { 'db.replica': { type: 'string', requiredIf: { path: 'db.url', equals: 'cluster' } } };

test('R29 asks for the path when the other path holds the trigger value', () => {
  assert.deepEqual(checkRequiredIf({ db: { url: 'cluster' } }, REQ_IF), {
    ok: false,
    errors: [{ path: 'db.replica', message: 'is required when db.url is cluster' }],
  });
});

test('R29 says nothing when the other path holds a different value', () => {
  assert.deepEqual(checkRequiredIf({ db: { url: 'single' } }, REQ_IF), { ok: true });
});

test('R29 says nothing when the carrying path is set too', () => {
  assert.deepEqual(checkRequiredIf({ db: { url: 'cluster', replica: 'r' } }, REQ_IF), { ok: true });
});

// ---------------------------------------------------------------------------
// R30 — list item count
// ---------------------------------------------------------------------------

test('R30 reports a list with too few items', () => {
  assert.deepEqual(checkListLength({ a: { x: [] } }, { 'a.x': { type: 'list', minItems: 1 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must have at least 1 items' }] });
});

test('R30 reports a list with too many items', () => {
  assert.deepEqual(
    checkListLength({ a: { x: ['p', 'q', 'r'] } }, { 'a.x': { type: 'list', maxItems: 2 } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must have at most 2 items' }] });
});

test('R30 says nothing when the item count sits inside the range', () => {
  assert.deepEqual(
    checkListLength({ a: { x: ['p'] } }, { 'a.x': { type: 'list', minItems: 1, maxItems: 2 } }),
    { ok: true });
});

// ---------------------------------------------------------------------------
// R31 — no duplicate list items
// ---------------------------------------------------------------------------

test('R31 reports a repeated string in a list', () => {
  assert.deepEqual(checkUnique({ a: { x: ['p', 'q', 'p'] } }, { 'a.x': { type: 'list', unique: true } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must not repeat a value' }] });
});

test('R31 says nothing when every item differs', () => {
  assert.deepEqual(checkUnique({ a: { x: ['p', 'q'] } }, { 'a.x': { type: 'list', unique: true } }),
    { ok: true });
});

test('R31 gives one error per path however many duplicates it holds', () => {
  const r = checkUnique({ a: { x: ['p', 'p', 'p', 'q', 'q'] } },
    { 'a.x': { type: 'list', unique: true } });
  assert.deepEqual(r.errors, [{ path: 'a.x', message: 'must not repeat a value' }]);
});

test('R31 compares coerced integers, so two equal numbers repeat', () => {
  assert.deepEqual(
    checkUnique({ a: { x: [1, 2, 1] } }, { 'a.x': { type: 'list<integer>', unique: true } }),
    { ok: false, errors: [{ path: 'a.x', message: 'must not repeat a value' }] });
});

// ---------------------------------------------------------------------------
// R32 — aggregate every check into one result
// ---------------------------------------------------------------------------

const collect = (rawConfig, schema, together = [], exclusive = []) => collectErrors({
  rawConfig,
  schema,
  requiredTogetherGroups: together,
  mutuallyExclusiveGroups: exclusive,
});

test('R32 stops at stage basic when the R2 validation fails', () => {
  assert.deepEqual(collect({}, { 'a.x': { type: 'number', required: true } }), {
    ok: false,
    stage: 'basic',
    errors: [{ path: 'a.x', message: 'is required' }],
  });
});

test('R32 stops at stage basic when the extra-type coercion fails', () => {
  assert.deepEqual(collect({ a: { x: 'z' } }, { 'a.x': { type: 'integer' } }), {
    ok: false,
    stage: 'basic',
    errors: [{ path: 'a.x', message: 'must be an integer' }],
  });
});

test('R32 returns the coerced value when every check passes', () => {
  assert.deepEqual(collect({ a: { x: '3' } }, { 'a.x': { type: 'integer' } }),
    { ok: true, value: { a: { x: 3 } } });
});

test('R32 runs every constraint check, not only the first one that fails', () => {
  const schema = { 'a.x': { type: 'integer', min: 10 }, 'a.y': { type: 'string', maxLength: 1 } };
  assert.deepEqual(collect({ a: { x: '1', y: 'zz' } }, schema), {
    ok: false,
    stage: 'constraints',
    errors: [
      { path: 'a.x', message: 'must be at least 10' },
      { path: 'a.y', message: 'must be at most 1 characters' },
    ],
  });
});

test('R32 keeps two errors on one path in the order the checks are listed', () => {
  const schema = { 'a.x': { type: 'string', maxLength: 1, oneOf: ['ok'] } };
  assert.deepEqual(collect({ a: { x: 'zz' } }, schema), {
    ok: false,
    stage: 'constraints',
    errors: [
      { path: 'a.x', message: 'must be at most 1 characters' },
      { path: 'a.x', message: 'must be one of ok' },
    ],
  });
});

test('R32 wires the two group lists into the constraint stage', () => {
  const schema = { 'db.user': { type: 'string' }, 'db.pass': { type: 'string' } };
  assert.deepEqual(collect({ db: { user: 'a' } }, schema, [['db.user', 'db.pass']]), {
    ok: false,
    stage: 'constraints',
    errors: [{ path: 'db.pass', message: 'must be set together with db.user' }],
  });
});

test('R32 leaves checkUnknownKeys out, so a key the schema misses passes', () => {
  assert.deepEqual(collect({ a: { x: '1' }, b: { z: '2' } }, { 'a.x': { type: 'integer' } }),
    { ok: true, value: { a: { x: 1 } } });
});
