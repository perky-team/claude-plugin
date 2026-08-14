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

// ---------------------------------------------------------------------------
// R33 — trace which layer set each key
// ---------------------------------------------------------------------------

test('R33 keeps the value and the name of the LAST layer that set a path', () => {
  assert.deepEqual(
    traceLayers([{ server: { host: 'a' } }, { server: { host: 'b', port: '9' } }],
      ['file', 'flags']),
    { 'server.host': { value: 'b', layer: 'flags' }, 'server.port': { value: '9', layer: 'flags' } },
  );
});

test('R33 keeps a path only an earlier layer set, named after that layer', () => {
  assert.deepEqual(
    traceLayers([{ a: { x: '1' } }, { b: { y: '2' } }], ['file', 'flags']),
    { 'a.x': { value: '1', layer: 'file' }, 'b.y': { value: '2', layer: 'flags' } },
  );
});

test('R33 orders paths by where they were first seen, not by the winner', () => {
  const trace = traceLayers([{ b: { y: '1' } }, { a: { x: '2' } }, { b: { y: '3' } }],
    ['one', 'two', 'three']);
  assert.deepEqual(Object.keys(trace), ['b.y', 'a.x']);
  assert.deepEqual(trace['b.y'], { value: '3', layer: 'three' });
});

test('R33 names a key with no section by the bare key', () => {
  assert.deepEqual(traceLayers([{ '': { v: '1' } }], ['flags']),
    { v: { value: '1', layer: 'flags' } });
});

// ---------------------------------------------------------------------------
// R34 — print the trace
// ---------------------------------------------------------------------------

test('R34 writes a path, its value and its layer on one line', () => {
  assert.equal(formatProvenance({ 'server.host': { value: 'b', layer: 'flags' } }),
    'server.host = b (flags)');
});

test('R34 sorts by path and adds no trailing newline', () => {
  assert.equal(formatProvenance({
    'b.y': { value: '2', layer: 'flags' },
    'a.x': { value: '1', layer: 'file' },
  }), 'a.x = 1 (file)\nb.y = 2 (flags)');
});

test('R34 gives an empty string for an empty trace', () => {
  assert.equal(formatProvenance({}), '');
});

// ---------------------------------------------------------------------------
// R35 — a dotenv-style report
// ---------------------------------------------------------------------------

test('R35 upper-cases the section and the key and joins them with an underscore', () => {
  assert.equal(toDotenv({ '': { verbose: 'true' }, server: { host: 'localhost', port: '9' } }),
    'VERBOSE=true\nSERVER_HOST=localhost\nSERVER_PORT=9');
});

test('R35 leaves the empty section out along with its underscore', () => {
  assert.equal(toDotenv({ '': { verbose: 'true' } }), 'VERBOSE=true');
});

test('R35 sorts sections and, inside each, keys', () => {
  assert.equal(toDotenv({ b: { y: '1' }, a: { z: '2', x: '3' } }), 'A_X=3\nA_Z=2\nB_Y=1');
});

test('R35 prints a list value the way String() joins it, with commas', () => {
  assert.equal(toDotenv({ a: { tags: ['x', 'y'] } }), 'A_TAGS=x,y');
});

test('R35 prints a number and a boolean through plain String()', () => {
  assert.equal(toDotenv({ a: { n: 9, b: true } }), 'A_B=true\nA_N=9');
});

// ---------------------------------------------------------------------------
// R36 — a flat `path=value` report
// ---------------------------------------------------------------------------

test('R36 writes the dotted path with no case change', () => {
  assert.equal(toFlat({ '': { verbose: 'true' }, server: { host: 'localhost' } }),
    'verbose=true\nserver.host=localhost');
});

test('R36 uses the bare key for a value with no section', () => {
  assert.equal(toFlat({ '': { v: '1' } }), 'v=1');
});

test('R36 sorts sections and keys and adds no trailing newline', () => {
  assert.equal(toFlat({ b: { y: '1' }, a: { z: '2', x: '3' } }), 'a.x=3\na.z=2\nb.y=1');
});

// ---------------------------------------------------------------------------
// R37 — unquote one value
// ---------------------------------------------------------------------------

test('R37 takes the text between the two outer quotes', () => {
  assert.equal(unquote('"a,b"'), 'a,b');
});

test('R37 leaves a value that is not quoted alone', () => {
  assert.equal(unquote('a,b'), 'a,b');
});

test('R37 leaves a value alone when only one end carries a quote', () => {
  assert.equal(unquote('"abc'), '"abc');
});

test('R37 replaces every backslash-quote pair with a single quote', () => {
  assert.equal(unquote('"say \\"hi\\""'), 'say "hi"');
});

test('R37 leaves a lone backslash exactly as it is', () => {
  assert.equal(unquote('"a\\b"'), 'a\\b');
});

test('R37 never reads two backslashes as one escaped backslash', () => {
  assert.equal(unquote('"a\\\\b"'), 'a\\\\b');
});

test('R37 leaves a single quote character alone, being shorter than two', () => {
  assert.equal(unquote('"'), '"');
});

// ---------------------------------------------------------------------------
// R38 — unquote a whole config
// ---------------------------------------------------------------------------

test('R38 unquotes every leaf value in the config', () => {
  assert.deepEqual(unquoteConfig({ a: { x: '"1,2"' }, b: { y: '"z"' } }),
    { a: { x: '1,2' }, b: { y: 'z' } });
});

test('R38 leaves a leaf that carries no quotes alone', () => {
  assert.deepEqual(unquoteConfig({ a: { x: '1,2' } }), { a: { x: '1,2' } });
});

test('R38 does not change its input', () => {
  const input = { a: { x: '"1"' } };
  unquoteConfig(input);
  assert.deepEqual(input, { a: { x: '"1"' } });
});

// ---------------------------------------------------------------------------
// R39 — diff two resolved values
// ---------------------------------------------------------------------------

test('R39 reports a changed value and a path that is new on the right', () => {
  const d = diffResolved({ a: { x: 1 } }, { a: { x: 2, y: 3 } });
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { path: 'a.x', before: 1, after: 2 });
  assert.equal(d[1].path, 'a.y');
  assert.equal(d[1].before, undefined);
  assert.equal(d[1].after, 3);
});

test('R39 leaves after undefined for a path the right side dropped', () => {
  const d = diffResolved({ a: { x: 1 } }, {});
  assert.equal(d.length, 1);
  assert.equal(d[0].path, 'a.x');
  assert.equal(d[0].before, 1);
  assert.equal(d[0].after, undefined);
});

test('R39 leaves out a path whose value did not change', () => {
  assert.deepEqual(diffResolved({ a: { x: 1 } }, { a: { x: 1 } }), []);
});

test('R39 counts two separately built arrays with the same items as equal', () => {
  assert.deepEqual(diffResolved({ a: { x: ['p', 'q'] } }, { a: { x: ['p', 'q'] } }), []);
});

test('R39 sorts what it found by path', () => {
  const d = diffResolved({ b: { y: 1 }, a: { x: 1 } }, { b: { y: 2 }, a: { x: 2 } });
  assert.deepEqual(d.map((e) => e.path), ['a.x', 'b.y']);
});

// ---------------------------------------------------------------------------
// R40 — print a diff
// ---------------------------------------------------------------------------

test('R40 writes one arrow line per entry', () => {
  assert.equal(formatDiff([{ path: 'a.x', before: 1, after: 2 }]), 'a.x: 1 -> 2');
});

test('R40 writes the literal text undefined for a missing side', () => {
  assert.equal(formatDiff([{ path: 'a.y', before: undefined, after: 3 }]),
    'a.y: undefined -> 3');
});

test('R40 gives an empty string for an empty array', () => {
  assert.equal(formatDiff([]), '');
});

// ---------------------------------------------------------------------------
// R41 — summarize an error list
// ---------------------------------------------------------------------------

test('R41 counts every error but lists a repeated path once', () => {
  assert.deepEqual(summarizeErrors([
    { path: 'a.x', message: 'is required' },
    { path: 'a.x', message: 'must be a number' },
  ]), { count: 2, paths: ['a.x'] });
});

test('R41 sorts the paths it lists', () => {
  assert.deepEqual(summarizeErrors([
    { path: 'b.y', message: 'm' },
    { path: 'a.x', message: 'm' },
    { path: 'b.y', message: 'm' },
  ]), { count: 3, paths: ['a.x', 'b.y'] });
});

test('R41 gives a count of zero and no paths for an empty list', () => {
  assert.deepEqual(summarizeErrors([]), { count: 0, paths: [] });
});

// ---------------------------------------------------------------------------
// R42 — print a summary
// ---------------------------------------------------------------------------

test('R42 says no errors when the count is zero', () => {
  assert.equal(formatSummary({ count: 0, paths: [] }), 'no errors');
});

test('R42 names the count, the path count and the paths', () => {
  assert.equal(formatSummary({ count: 2, paths: ['a.x', 'b.y'] }),
    '2 error(s) across 2 path(s): a.x, b.y');
});

test('R42 takes the path count from the list length, not from the error count', () => {
  assert.equal(formatSummary({ count: 5, paths: ['a.x'] }),
    '5 error(s) across 1 path(s): a.x');
});

// ---------------------------------------------------------------------------
// R43 — the extended schema
// ---------------------------------------------------------------------------

// A config `EXT_SCHEMA` accepts, leaving server.host and server.mode to their
// defaults. Every polyctl test below starts from this unless it says otherwise.
const CTL_OK = '[server]\nport = 8080\n';
// What a successful run prints, in each of R48's three formats.
const CTL_JSON = '{\n  "server": {\n    "host": "localhost",\n    "mode": "production",\n    "port": 8080\n  }\n}\n';
const CTL_DOTENV = 'SERVER_HOST=localhost\nSERVER_MODE=production\nSERVER_PORT=8080\n';
const CTL_FLAT = 'server.host=localhost\nserver.mode=production\nserver.port=8080\n';

test('R43 fills server.host and server.mode from their defaults', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { server: { host: 'localhost', mode: 'production', port: 8080 } });
});

test('R43 requires server.port', () => {
  const r = ctl(['check', withFile('')]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /server\.port: is required/);
});

test('R43 types server.port as an integer, not a number', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.port=8080.5']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /server\.port: must be an integer/);
});

test('R43 holds server.port to at least 1', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.port=0']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.port: must be at least 1/);
});

test('R43 holds server.port to at most 65535', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.port=70000']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.port: must be at most 65535/);
});

test('R43 holds server.host to at most 255 characters', () => {
  const r = ctl(['check', withFile(CTL_OK), `--server.host=${'a'.repeat(256)}`]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.host: must be at most 255 characters/);
});

test('R43 allows only its three values for server.mode', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.mode=other']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.mode: must be one of development, staging, production/);
});

test('R43 holds server.tag to its pattern', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.tag=Bad']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.tag: must match \^\[a-z\]\[a-z0-9-\]\*\$/);
});

test('R43 allows at most five server.aliases', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.aliases=a,b,c,d,e,f']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.aliases: must have at most 5 items/);
});

test('R43 refuses a repeated server.alias', () => {
  const r = ctl(['check', withFile(CTL_OK), '--server.aliases=a,a']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /server\.aliases: must not repeat a value/);
});

test('R43 asks for db.pass once db.user is set', () => {
  const r = ctl(['check', withFile(CTL_OK), '--db.user=u']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /db\.pass: must be set together with db\.user/);
});

test('R43 refuses db.url and db.user together', () => {
  const r = ctl(['check', withFile(CTL_OK), '--db.url=x', '--db.user=u']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /db\.url: cannot be set together with db\.user/);
});

test('R43 asks for db.replica when db.url is cluster', () => {
  const r = ctl(['check', withFile(CTL_OK), '--db.url=cluster']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /db\.replica: is required when db\.url is cluster/);
});

// ---------------------------------------------------------------------------
// R44 — the `resolve` subcommand, and the shared pipeline
// ---------------------------------------------------------------------------

test('R44 exits 64 when polyctl is given no arguments at all', () => {
  assert.equal(ctl([]).status, 64);
});

test('R44 exits 65 and names a subcommand it does not know', () => {
  const r = ctl(['bogus']);
  assert.equal(r.status, 65);
  assert.equal(r.stderr, 'unknown subcommand: bogus\n');
});

test('R44 exits 64 and prints nothing when the subcommand has no path', () => {
  const r = ctl(['resolve']);
  assert.equal(r.status, 64);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('R44 exits 2 when the config file cannot be read', () => {
  const r = ctl(['resolve', `${withFile('')}.missing`]);
  assert.equal(r.status, 2);
  assert.notEqual(r.stderr, '');
});

test('R44 exits 2 and prints the parse error when the file cannot be parsed', () => {
  const r = ctl(['resolve', withFile('???\n')]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'line 1: ???\n');
});

test('R44 exits 2 when the config includes a file it was not given', () => {
  const r = ctl(['resolve', withFile('include = base.ini\n[server]\nport = 8080\n')]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'no such include: base.ini\n');
});

test('R44 exits 0 and prints nothing on a plain successful resolve', () => {
  const r = ctl(['resolve', withFile(CTL_OK)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('R44 prints the resolved value with --json, sorted and indented', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_JSON);
});

test('R44 exits 3 on a basic failure and prints nothing on stdout', () => {
  const r = ctl(['resolve', withFile(''), '--json']);
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'server.port: is required\n');
});

test('R44 exits 4 on a constraint failure and prints nothing on stdout', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json', '--server.port=99999']);
  assert.equal(r.status, 4);
  assert.equal(r.stdout, '');
});

test('R44 filters every control flag out before parseFlags ever sees it', () => {
  // --strict is the detector: any control flag left in the config would show up
  // as an unknown key and turn this into an exit 5.
  const r = ctl(['resolve', withFile(CTL_OK), '--json', '--strict', '--summary',
    '--quiet', '--full', '--diff', '--format=flat']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_JSON);
});

test('R44 gives all four subcommands the same exit code on one broken config', () => {
  const p = withFile('');
  for (const sub of ['resolve', 'check', 'explain', 'report']) {
    assert.equal(ctl([sub, p]).status, 3, sub);
  }
});

// ---------------------------------------------------------------------------
// R45 — the `check` subcommand
// ---------------------------------------------------------------------------

test('R45 prints nothing on stdout on a successful check', () => {
  const r = ctl(['check', withFile(CTL_OK)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('R45 ignores --json and still prints nothing', () => {
  const r = ctl(['check', withFile(CTL_OK), '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('R45 ignores --format and still prints nothing', () => {
  const r = ctl(['check', withFile(CTL_OK), '--format=dotenv']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('R45 keeps the shared exit codes, 3 for basic and 4 for constraints', () => {
  assert.equal(ctl(['check', withFile('')]).status, 3);
  assert.equal(ctl(['check', withFile(CTL_OK), '--server.port=99999']).status, 4);
});

// ---------------------------------------------------------------------------
// R46 — read real environment variables, in one place only
// ---------------------------------------------------------------------------

test('R46 reads a POLYGON variable out of the real environment', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json'],
    { POLYGON__server__host: 'env.example' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).server.host, 'env.example');
});

test('R46 lets the environment beat the file', () => {
  const p = withFile('[server]\nport = 8080\nhost = file.example\n');
  const r = ctl(['resolve', p, '--json'], { POLYGON__server__host: 'env.example' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).server.host, 'env.example');
});

test('R46 lets a flag beat the environment', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json', '--server.host=flag.example'],
    { POLYGON__server__host: 'env.example' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).server.host, 'flag.example');
});

test('R46 ignores a variable that does not carry the POLYGON prefix', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json'],
    { OTHER__server__host: 'env.example' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_JSON);
});

test('R46 ignores a POLYGON variable with no second double underscore', () => {
  const r = ctl(['resolve', withFile(CTL_OK), '--json'], { POLYGON__host: 'env.example' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_JSON);
});

// ---------------------------------------------------------------------------
// R47 — the `explain` subcommand
// ---------------------------------------------------------------------------

test('R47 names the layer that won every path', () => {
  const r = ctl(['explain', withFile(CTL_OK)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host = localhost (defaults)\n'
    + 'server.mode = production (defaults)\n'
    + 'server.port = 8080 (file)\n');
});

test('R47 names the flags layer for a value a flag set', () => {
  const r = ctl(['explain', withFile(CTL_OK), '--server.host=x']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host = x (flags)\n'
    + 'server.mode = production (defaults)\n'
    + 'server.port = 8080 (file)\n');
});

test('R47 names the env layer for a value the environment set', () => {
  const r = ctl(['explain', withFile(CTL_OK)], { POLYGON__server__host: 'e' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host = e (env)\n'
    + 'server.mode = production (defaults)\n'
    + 'server.port = 8080 (file)\n');
});

test('R47 keeps the shared exit codes and prints nothing on stdout when it fails', () => {
  const r = ctl(['explain', withFile('')]);
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
});

// ---------------------------------------------------------------------------
// R48 — the `report` subcommand, and output formats
// ---------------------------------------------------------------------------

test('R48 falls back to json when no --format is given', () => {
  const r = ctl(['report', withFile(CTL_OK)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_JSON);
});

test('R48 prints json for --format=json', () => {
  const r = ctl(['report', withFile(CTL_OK), '--format=json']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_JSON);
});

test('R48 prints dotenv for --format=dotenv', () => {
  const r = ctl(['report', withFile(CTL_OK), '--format=dotenv']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_DOTENV);
});

test('R48 prints the flat form for --format=flat', () => {
  const r = ctl(['report', withFile(CTL_OK), '--format=flat']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_FLAT);
});

// ---------------------------------------------------------------------------
// R49 — `--strict`
// ---------------------------------------------------------------------------

const CTL_EXTRA = '[server]\nport = 8080\n[extra]\nz = 1\n';

test('R49 exits 5 on a key the schema does not name', () => {
  const r = ctl(['resolve', withFile(CTL_EXTRA), '--strict']);
  assert.equal(r.status, 5);
  assert.equal(r.stderr, 'extra.z: unknown key\n');
});

test('R49 leaves unknown keys alone when --strict is absent', () => {
  assert.equal(ctl(['resolve', withFile(CTL_EXTRA)]).status, 0);
});

test('R49 prints nothing on stdout when it exits 5', () => {
  const r = ctl(['resolve', withFile(CTL_EXTRA), '--json', '--strict']);
  assert.equal(r.status, 5);
  assert.equal(r.stdout, '');
});

test('R49 works on any subcommand, check included', () => {
  assert.equal(ctl(['check', withFile(CTL_EXTRA), '--strict']).status, 5);
});

// ---------------------------------------------------------------------------
// R50 — `--summary`
// ---------------------------------------------------------------------------

test('R50 adds a summary line after the errors on exit 3', () => {
  const r = ctl(['check', withFile(''), '--summary']);
  assert.equal(r.status, 3);
  assert.equal(r.stderr,
    'server.port: is required\n1 error(s) across 1 path(s): server.port\n');
});

test('R50 adds a summary line on exit 4', () => {
  const r = ctl(['check', withFile(CTL_OK), '--summary', '--server.port=99999']);
  assert.equal(r.status, 4);
  assert.equal(r.stderr,
    'server.port: must be at most 65535\n1 error(s) across 1 path(s): server.port\n');
});

test('R50 adds a summary line on exit 5', () => {
  const r = ctl(['check', withFile(CTL_EXTRA), '--strict', '--summary']);
  assert.equal(r.status, 5);
  assert.equal(r.stderr, 'extra.z: unknown key\n1 error(s) across 1 path(s): extra.z\n');
});

test('R50 adds nothing on exit 2, which carries no errors array', () => {
  const r = ctl(['check', withFile('???\n'), '--summary']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'line 1: ???\n');
});

// ---------------------------------------------------------------------------
// R51 — `report --diff`
// ---------------------------------------------------------------------------

test('R51 shows exactly what the flags changed', () => {
  const r = ctl(['report', withFile(CTL_OK), '--diff', '--server.host=x']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host: localhost -> x\n');
});

test('R51 shows an empty diff when the flags changed nothing', () => {
  const r = ctl(['report', withFile(CTL_OK), '--diff']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '\n');
});

test('R51 shows undefined on the left for a path only the flags set', () => {
  const r = ctl(['report', withFile(CTL_OK), '--diff', '--db.url=u']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'db.url: undefined -> u\n');
});

test('R51 replaces the --format output rather than adding to it', () => {
  const r = ctl(['report', withFile(CTL_OK), '--diff', '--format=dotenv', '--server.host=x']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host: localhost -> x\n');
});

test('R51 still works when the before side alone would fail validation', () => {
  const r = ctl(['report', withFile(''), '--diff', '--server.port=8080']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.port: undefined -> 8080\n');
});

// ---------------------------------------------------------------------------
// R52 — `--quiet`
// ---------------------------------------------------------------------------

test('R52 drops the stderr text on exit 3 but keeps the exit code', () => {
  const r = ctl(['check', withFile(''), '--quiet']);
  assert.equal(r.status, 3);
  assert.equal(r.stderr, '');
});

test('R52 drops the stderr text on exit 4', () => {
  const r = ctl(['check', withFile(CTL_OK), '--quiet', '--server.port=99999']);
  assert.equal(r.status, 4);
  assert.equal(r.stderr, '');
});

test('R52 drops the stderr text on exit 5', () => {
  const r = ctl(['check', withFile(CTL_EXTRA), '--strict', '--quiet']);
  assert.equal(r.status, 5);
  assert.equal(r.stderr, '');
});

test('R52 drops the summary line too when both flags are given', () => {
  const r = ctl(['check', withFile(''), '--quiet', '--summary']);
  assert.equal(r.status, 3);
  assert.equal(r.stderr, '');
});

test('R52 never touches the success output on stdout', () => {
  const r = ctl(['report', withFile(CTL_OK), '--quiet', '--format=flat']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_FLAT);
});

// ---------------------------------------------------------------------------
// R53 — explain one path in one sentence
// ---------------------------------------------------------------------------

test('R53 names the value and the layer that set it, in parentheses', () => {
  assert.equal(explainWinner({ 'a.x': { value: '1', layer: 'flags' } }, 'a.x'),
    'a.x = 1 (set by flags)');
});

test('R53 says a path the trace does not hold was never set', () => {
  assert.equal(explainWinner({}, 'a.x'), 'a.x was never set');
});

test('R53 says never set even when the trace holds other paths', () => {
  assert.equal(explainWinner({ 'b.y': { value: '2', layer: 'file' } }, 'a.x'),
    'a.x was never set');
});

// ---------------------------------------------------------------------------
// R54 — the full layer history of every path
// ---------------------------------------------------------------------------

test('R54 keeps every layer that touched a path, in layer order', () => {
  assert.deepEqual(
    tracedHistory([{ a: { x: '1' } }, { a: { x: '2' } }], ['file', 'flags']),
    { 'a.x': [{ layer: 'file', value: '1' }, { layer: 'flags', value: '2' }] },
  );
});

test('R54 keeps a path only one layer set as a one-entry array', () => {
  assert.deepEqual(
    tracedHistory([{ a: { x: '1' } }, { b: { y: '2' } }], ['file', 'flags']),
    { 'a.x': [{ layer: 'file', value: '1' }], 'b.y': [{ layer: 'flags', value: '2' }] },
  );
});

test('R54 names a key with no section by the bare key', () => {
  assert.deepEqual(tracedHistory([{ '': { v: '1' } }], ['flags']),
    { v: [{ layer: 'flags', value: '1' }] });
});

// ---------------------------------------------------------------------------
// R55 — print a layer history
// ---------------------------------------------------------------------------

test('R55 joins the layers of one path with arrows', () => {
  assert.equal(
    formatHistory({ 'a.x': [{ layer: 'file', value: '1' }, { layer: 'flags', value: '2' }] }),
    'a.x: file=1 -> flags=2',
  );
});

test('R55 sorts by path and adds no trailing newline', () => {
  assert.equal(formatHistory({
    'b.y': [{ layer: 'flags', value: '2' }],
    'a.x': [{ layer: 'file', value: '1' }],
  }), 'a.x: file=1\nb.y: flags=2');
});

test('R55 gives an empty string for an empty history', () => {
  assert.equal(formatHistory({}), '');
});

// ---------------------------------------------------------------------------
// R56 — `explain --full`
// ---------------------------------------------------------------------------

test('R56 prints the full layer history instead of the winner', () => {
  const r = ctl(['explain', withFile(CTL_OK), '--full', '--server.host=x']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host: defaults=localhost -> flags=x\n'
    + 'server.mode: defaults=production\n'
    + 'server.port: file=8080\n');
});

test('R56 leaves explain on the winner form when --full is absent', () => {
  const r = ctl(['explain', withFile(CTL_OK), '--server.host=x']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host = x (flags)\n'
    + 'server.mode = production (defaults)\n'
    + 'server.port = 8080 (file)\n');
});

test('R56 changes nothing about the other subcommands', () => {
  const r = ctl(['report', withFile(CTL_OK), '--full', '--format=flat']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, CTL_FLAT);
});

// ---------------------------------------------------------------------------
// R57 — flag a deprecated path
// ---------------------------------------------------------------------------

const DEP_SCHEMA = {
  'server.host': { type: 'string' },
  'server.legacyHost': { type: 'string', deprecated: 'server.host' },
};

test('R57 names the replacement when deprecated is a string', () => {
  assert.deepEqual(checkDeprecated({ server: { legacyHost: 'o' } }, DEP_SCHEMA), {
    warnings: [{ path: 'server.legacyHost', message: 'is deprecated, use server.host instead' }],
  });
});

test('R57 names no replacement when deprecated is just true', () => {
  assert.deepEqual(checkDeprecated({ a: { x: '1' } }, { 'a.x': { deprecated: true } }),
    { warnings: [{ path: 'a.x', message: 'is deprecated' }] });
});

test('R57 warns about nothing when the deprecated path is not set', () => {
  assert.deepEqual(checkDeprecated({ server: { host: 'h' } }, DEP_SCHEMA), { warnings: [] });
});

test('R57 throws a TypeError when the named replacement is not a schema path', () => {
  assert.throws(() => checkDeprecated({}, { 'a.x': { deprecated: 'b.y' } }),
    { name: 'TypeError', message: 'unknown replacement path: b.y' });
});

test('R57 sorts its warnings by path', () => {
  const schema = { 'b.y': { deprecated: true }, 'a.x': { deprecated: true } };
  const r = checkDeprecated({ a: { x: '1' }, b: { y: '2' } }, schema);
  assert.deepEqual(r.warnings.map((w) => w.path), ['a.x', 'b.y']);
});

// ---------------------------------------------------------------------------
// R58 — print warnings on every successful run
// ---------------------------------------------------------------------------

const CTL_DEP = '[server]\nport = 8080\nlegacyHost = old.example.com\n';

test('R58 prints the warning on stderr and still exits 0', () => {
  const r = ctl(['resolve', withFile(CTL_DEP)]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, 'server.legacyHost: is deprecated, use server.host instead\n');
});

test('R58 prints the warning for check too, whose stdout stays empty', () => {
  const r = ctl(['check', withFile(CTL_DEP)]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'server.legacyHost: is deprecated, use server.host instead\n');
});

test('R58 prints nothing on stderr when no deprecated path is set', () => {
  const r = ctl(['resolve', withFile(CTL_OK)]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

// ---------------------------------------------------------------------------
// R59 — a second deprecated path
// ---------------------------------------------------------------------------

test('R59 warns about server.legacyHost and names server.host as its replacement', () => {
  const r = ctl(['report', withFile(CTL_DEP), '--format=flat']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, 'server.legacyHost: is deprecated, use server.host instead\n');
});

test('R59 counts server.legacyHost as a key the schema names, so --strict passes', () => {
  assert.equal(ctl(['check', withFile(CTL_DEP), '--strict']).status, 0);
});

// ---------------------------------------------------------------------------
// R60 — deprecated paths, end to end
// ---------------------------------------------------------------------------

const CTL_DEP2 = '[server]\nport = 8080\nlegacyHost = old.example.com\nlegacyPort = 9000\n';

test('R60 types server.legacyPort as an integer', () => {
  const r = ctl(['check', withFile('[server]\nport = 8080\nlegacyPort = abc\n')]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /server\.legacyPort: must be an integer/);
});

test('R60 prints both warnings, sorted by path, as one formatErrors block', () => {
  const r = ctl(['resolve', withFile(CTL_DEP2)]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, 'server.legacyHost: is deprecated, use server.host instead\n'
    + 'server.legacyPort: is deprecated, use server.port instead\n');
});

test('R60 leaves stdout as whatever the subcommand normally prints', () => {
  const r = ctl(['report', withFile(CTL_DEP2), '--format=flat']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'server.host=localhost\n'
    + 'server.legacyHost=old.example.com\n'
    + 'server.legacyPort=9000\n'
    + 'server.mode=production\n'
    + 'server.port=8080\n');
});

test('R60 exits 0 on every subcommand with both deprecated paths set', () => {
  const p = withFile(CTL_DEP2);
  for (const sub of ['resolve', 'check', 'explain', 'report']) {
    assert.equal(ctl([sub, p]).status, 0, sub);
  }
});
