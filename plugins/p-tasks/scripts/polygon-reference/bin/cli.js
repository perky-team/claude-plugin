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

function main(argv) {
  if (argv.length === 0) return 64;

  const [path, ...after] = argv;
  // `--json` picks the output format. It is never a config key.
  const wantsJson = after.includes('--json');
  const flagArgs = after.filter((arg) => arg !== '--json');

  let result;
  try {
    const text = readFileSync(path, 'utf-8');
    result = resolve({ text, argv: flagArgs, schema: SCHEMA });
  } catch (err) {
    // R1 throwing is the case the spec names. A file that cannot be read at all
    // lands here too, so it gets a plain message instead of a stack trace.
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  if (!result.ok) {
    process.stderr.write(`${formatErrors(result.errors)}\n`);
    return 3;
  }

  if (wantsJson) process.stdout.write(`${toJson(result.value)}\n`);
  return 0;
}

// Set the code and let Node exit on its own. `process.exit()` can cut a pending
// write to a pipe short, which would show up later as a flaky test.
process.exitCode = main(process.argv.slice(2));
