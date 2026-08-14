#!/usr/bin/env node
// R43 — the extended schema. R44 — the `resolve` subcommand, and the shared
// pipeline. R45 — the `check` subcommand. R46 — read real environment
// variables, in one place only. R47 — the `explain` subcommand. R48 — the
// `report` subcommand, and output formats. R49 — `--strict`. R50 —
// `--summary`. R51 — `report --diff`. R52 — `--quiet`. R56 — `explain
// --full`. R58 — print warnings on every successful run. R59/R60 — two
// deprecated paths.
import { readFileSync } from 'node:fs';
import { parseIni } from '../src/parse.js';
import { resolveIncludes } from '../src/include.js';
import { envToConfig } from '../src/env.js';
import { parseFlags } from '../src/flags.js';
import { defaultsAsLayer } from '../src/defaultsLayer.js';
import { mergeLayers } from '../src/merge.js';
import { collectErrors } from '../src/aggregate.js';
import { checkUnknownKeys, checkDeprecated } from '../src/rules.js';
import { formatErrors } from '../src/errors.js';
import { toJson } from '../src/report.js';
import { toDotenv, toFlat } from '../src/format.js';
import { traceLayers, formatProvenance, tracedHistory, formatHistory } from '../src/provenance.js';
import { diffResolved, formatDiff } from '../src/diff.js';
import { summarizeErrors, formatSummary } from '../src/summary.js';

// R43 fixes the schema and the group lists. bin/cli.js (R9/R10) is untouched.
const EXT_SCHEMA = {
  'server.port': { type: 'integer', required: true, min: 1, max: 65535 },
  'server.host': { type: 'string', default: 'localhost', minLength: 1, maxLength: 255 },
  'server.mode': { type: 'string', default: 'production', oneOf: ['development', 'staging', 'production'] },
  'server.tag': { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
  'server.aliases': { type: 'list', minItems: 0, maxItems: 5, unique: true },
  'db.user': { type: 'string' },
  'db.pass': { type: 'string' },
  'db.url': { type: 'string' },
  'db.replica': { type: 'string', requiredIf: { path: 'db.url', equals: 'cluster' } },
  // R59
  'server.legacyHost': { type: 'string', deprecated: 'server.host' },
  // R60
  'server.legacyPort': { type: 'integer', deprecated: 'server.port' },
};
const EXT_REQUIRED_TOGETHER = [['db.user', 'db.pass']];
const EXT_MUTUALLY_EXCLUSIVE = [['db.url', 'db.user']];

const SUBCOMMANDS = ['resolve', 'check', 'explain', 'report'];

// Every control flag any requirement introduces is filtered out before the
// remaining flags ever reach parseFlags/resolveLayers — none of these are
// ever config keys.
function isControlFlag(arg) {
  return arg === '--json' || arg === '--strict' || arg === '--summary'
    || arg === '--diff' || arg === '--quiet' || arg === '--full'
    || arg === '--format' || arg.startsWith('--format=');
}

function getFormat(flags) {
  const found = flags.find((arg) => arg.startsWith('--format='));
  return found ? found.slice('--format='.length) : 'json';
}

function run(argv) {
  if (argv.length === 0) return { code: 64 };

  const subcommand = argv[0];
  if (!SUBCOMMANDS.includes(subcommand)) {
    return { code: 65, stderr: `unknown subcommand: ${subcommand}\n` };
  }
  if (argv.length === 1) return { code: 64 };

  const path = argv[1];
  const flags = argv.slice(2);

  const wantsJson = flags.includes('--json');
  const strict = flags.includes('--strict');
  const summary = flags.includes('--summary');
  const diff = flags.includes('--diff');
  const quiet = flags.includes('--quiet');
  const full = flags.includes('--full');
  const format = getFormat(flags);
  const cleanFlags = flags.filter((arg) => !isControlFlag(arg));

  let fromFile;
  let withIncludes;
  try {
    const text = readFileSync(path, 'utf-8');
    fromFile = parseIni(text);
    withIncludes = resolveIncludes(fromFile, {});
  } catch (err) {
    return { code: 2, stderr: `${err.message}\n` };
  }

  // R46: the one place either CLI reads process.env for real.
  const fromEnv = envToConfig(process.env, 'POLYGON');
  const fromFlags = parseFlags(cleanFlags).set;
  const defaultsLayer = defaultsAsLayer(EXT_SCHEMA);
  const rawConfig = mergeLayers([defaultsLayer, withIncludes, fromEnv, fromFlags]);

  const result = collectErrors({
    rawConfig,
    schema: EXT_SCHEMA,
    requiredTogetherGroups: EXT_REQUIRED_TOGETHER,
    mutuallyExclusiveGroups: EXT_MUTUALLY_EXCLUSIVE,
  });

  const errorOutput = (errors) => {
    if (quiet) return '';
    let out = `${formatErrors(errors)}\n`;
    if (summary) out += `${formatSummary(summarizeErrors(errors))}\n`;
    return out;
  };

  if (!result.ok) {
    const code = result.stage === 'basic' ? 3 : 4;
    return { code, stderr: errorOutput(result.errors) };
  }

  if (strict) {
    const unknown = checkUnknownKeys(rawConfig, EXT_SCHEMA);
    if (!unknown.ok) return { code: 5, stderr: errorOutput(unknown.errors) };
  }

  // Success from here on (exit 0). R58: warnings print to stderr first,
  // before the subcommand's own stdout.
  const deprecation = checkDeprecated(rawConfig, EXT_SCHEMA);
  const stderr = deprecation.warnings.length > 0 ? `${formatErrors(deprecation.warnings)}\n` : '';

  let stdout = '';
  if (subcommand === 'resolve') {
    if (wantsJson) stdout = `${toJson(result.value)}\n`;
  } else if (subcommand === 'explain') {
    const layers = [defaultsLayer, withIncludes, fromEnv, fromFlags];
    const names = ['defaults', 'file', 'env', 'flags'];
    stdout = full
      ? `${formatHistory(tracedHistory(layers, names))}\n`
      : `${formatProvenance(traceLayers(layers, names))}\n`;
  } else if (subcommand === 'report') {
    if (diff) {
      const before = mergeLayers([defaultsLayer, withIncludes, fromEnv]);
      stdout = `${formatDiff(diffResolved(before, rawConfig))}\n`;
    } else if (format === 'dotenv') {
      stdout = `${toDotenv(result.value)}\n`;
    } else if (format === 'flat') {
      stdout = `${toFlat(result.value)}\n`;
    } else {
      stdout = `${toJson(result.value)}\n`;
    }
  }
  // subcommand === 'check': stdout stays empty, --json/--format ignored.

  return { code: 0, stdout, stderr };
}

function main(argv) {
  const { code, stdout, stderr } = run(argv);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  return code;
}

process.exitCode = main(process.argv.slice(2));
