#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[key] = true;
        } else {
          if (key in out) out[key] = [].concat(out[key], next);
          else out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function findRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function emitJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

export function die(message, exitCode = 1) {
  process.stderr.write(message + '\n');
  process.exit(exitCode);
}

const KNOWN = ['tick', 'run', 'install-cron', 'remove-cron', 'set-job', 'rm-job'];

async function main() {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  // Commands are wired in Task 10.
  die(`command ${command} not implemented yet`, 1);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) main();
