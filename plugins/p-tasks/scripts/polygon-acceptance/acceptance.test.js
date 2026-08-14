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

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'cli.js');
const withFile = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'polygon-')), 'c.ini');
  writeFileSync(p, text);
  return p;
};
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });

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
