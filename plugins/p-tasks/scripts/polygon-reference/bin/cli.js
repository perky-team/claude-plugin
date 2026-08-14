#!/usr/bin/env node
// R9 — exit codes. R10 — `--json`.
import { readFileSync } from 'node:fs';
import { parseIni } from '../src/parse.js';
import { parseFlags } from '../src/flags.js';
import { mergeLayers } from '../src/merge.js';
import { validate } from '../src/schema.js';
import { formatErrors } from '../src/errors.js';
import { toJson } from '../src/report.js';

const argv = process.argv.slice(2);
if (argv.length === 0) process.exit(64);

const [path, ...after] = argv;
// `--json` picks the output format. It is never a config key.
const wantsJson = after.includes('--json');
const flagArgs = after.filter((arg) => arg !== '--json');

const text = readFileSync(path, 'utf-8');

let fromFile;
try {
  fromFile = parseIni(text);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

const { set } = parseFlags(flagArgs);
const config = mergeLayers([fromFile, set]);

// The CLI is given no schema, so this check always passes today. The branch is
// here because R9 names exit 3 for a failed validation.
const result = validate(config, {});
if (!result.ok) {
  process.stderr.write(`${formatErrors(result.errors)}\n`);
  process.exit(3);
}

if (wantsJson) process.stdout.write(`${toJson(config)}\n`);
process.exit(0);
