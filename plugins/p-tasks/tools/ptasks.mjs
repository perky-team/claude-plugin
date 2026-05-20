#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export const VERSION = '0.1.0';

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else { key = a.slice(2); val = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; }
      if (opts[key] === undefined) opts[key] = val;
      else if (Array.isArray(opts[key])) opts[key].push(val);
      else opts[key] = [opts[key], val];
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

export function findRoot(cwd) {
  try {
    const out = execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim();
  } catch {
    return cwd;
  }
}

export function emitJson(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

export function die(msg, code = 1) {
  process.stderr.write(`ptasks: ${msg}\n`);
  process.exit(code);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const KNOWN = ['init', 'add', 'set', 'next', 'summary', 'sync'];
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  // Dispatch added per-command in subsequent tasks
  die(`command ${command} not implemented yet`, 1);
}
