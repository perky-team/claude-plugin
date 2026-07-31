#!/usr/bin/env node
process.removeAllListeners('warning'); // silence node:sqlite ExperimentalWarning

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './lib/paths.mjs';
import { readConfig, defaultConfig, readIgnorePatterns, PGRAPH_DIR } from './lib/config.mjs';
import { resolveDestination } from './lib/destination.mjs';
import { runCommand } from './lib/cli/commands.mjs';

// Version comes from the plugin manifest, never a constant here: a release bumps
// plugin.json#version only, so a hardcoded copy drifts silently (this one sat at 0.1.0
// while the plugin shipped 0.7.0). The manifest ships in the same copied tree, so this
// resolves in the installed plugin cache too; a missing manifest degrades to 0.0.0
// rather than killing an unrelated command.
function readVersion() {
  try {
    const manifest = new URL('../.claude-plugin/plugin.json', import.meta.url);
    return JSON.parse(readFileSync(manifest, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const KNOWN =['index', 'status', 'search', 'node', 'callers', 'callees', 'impact', 'trace', 'context', 'explore', 'files'];

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else { const nx = argv[i + 1]; opts[a.slice(2)] = (nx === undefined || nx.startsWith('--')) ? true : argv[++i]; }
    } else opts._.push(a);
  }
  return opts;
}
function out(s) { process.stdout.write(s + '\n'); }
function emitJson(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function warn(s) { process.stderr.write(s + '\n'); }
function die(msg, code = 1) { process.stderr.write(`pgraph: ${msg}\n`); process.exit(code); }

const argv = process.argv.slice(2);
if (argv[0] === '--version') { out(readVersion()); process.exit(0); }
const command = argv[0];
const opts = parseArgs(argv.slice(1));
if (!KNOWN.includes(command)) die(`unknown command: ${command ?? '(none)'}`);

const root = findRepoRoot();
let cfg;
try { cfg = readConfig(root) ?? defaultConfig(); }
catch (e) { die(`invalid ${PGRAPH_DIR}/config.json: ${e.message}`, 1); }
const dbPath = join(root, PGRAPH_DIR, 'graph.db');

// `index` is the bootstrap command — create .pgraph/ so opening the DB
// doesn't fail with a cryptic "unable to open database file".
if (command === 'index') {
  try { mkdirSync(join(root, PGRAPH_DIR), { recursive: true }); }
  catch (e) { die(e.message, 1); }
}

let store;
try {
  store = resolveDestination(cfg, dbPath);
} catch (e) {
  // Writable (WAL) open failed — e.g. a read-only filesystem. Fall back to a
  // read-only store so the query can still answer (the refresh will then degrade
  // with a banner). If even this fails, there is genuinely no graph to read.
  try { store = resolveDestination(cfg, dbPath, { readOnly: true }); }
  catch { die(e.message, 1); }
}

try {
  await runCommand({
    command, opts, root, store,
    ignorePatterns: readIgnorePatterns(root),
    pgraphDir: join(root, PGRAPH_DIR),
    out, emitJson, warn, die,
  });
} catch (e) {
  try { store.close(); } catch { /* ignore */ }
  die(e?.message ?? String(e), 3);
}
store.close();
