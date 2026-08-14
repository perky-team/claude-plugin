#!/usr/bin/env node
// R9 — exit codes. R10 — `--json`.
import { readFileSync } from 'node:fs';
import { resolve } from '../src/resolve.js';
import { formatErrors } from '../src/errors.js';
import { toJson } from '../src/report.js';

// R9 fixes the schema. The CLI checks every config against these three paths.
const SCHEMA = {
  'server.port': { type: 'number', required: true },
  'server.host': { type: 'string', default: 'localhost' },
  'server.debug': { type: 'boolean', default: false },
};

const argv = process.argv.slice(2);
if (argv.length === 0) process.exit(64);

const [path, ...after] = argv;
// `--json` picks the output format. It is never a config key.
const wantsJson = after.includes('--json');
const flagArgs = after.filter((arg) => arg !== '--json');

const text = readFileSync(path, 'utf-8');

let result;
try {
  result = resolve({ text, argv: flagArgs, schema: SCHEMA });
} catch (err) {
  // Only R1 throws in this pipeline, so this is always a parse failure.
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

if (!result.ok) {
  process.stderr.write(`${formatErrors(result.errors)}\n`);
  process.exit(3);
}

if (wantsJson) process.stdout.write(`${toJson(result.value)}\n`);
process.exit(0);
