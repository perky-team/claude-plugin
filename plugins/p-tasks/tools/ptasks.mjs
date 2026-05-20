#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, writeConfig, defaultConfig } from './lib/config.mjs';
import { createFsDestination } from './lib/destinations/fs.mjs';

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

const CLAUDE_MD_BODY = `# p-tasks data store

Tasks live in \`tasks.yml\` at this directory. Two-level hierarchy:
- top-level: \`task\` (\`id: t-N\`)
- nested under \`subTasks\`: \`sub-task\` (\`id: st-N\`)

Statuses: \`todo\` | \`in_progress\` | \`done\`. Use \`/p-tasks:\` commands to mutate.
Do not hand-edit unless you know what you are doing — id reuse is forbidden.
`;

const RULE_BODY = `# p-tasks

A task tracker plugin is installed in this repo (\`docs/tasks/tasks.yml\`).
Slash commands: \`/p-tasks:add\`, \`/p-tasks:set\`, \`/p-tasks:next\`, \`/p-tasks:summary\`, \`/p-tasks:sync\`.
\`/p-tasks:init\` is one-shot — do not re-run it.
`;

export async function initFs({ root }) {
  if (existsSync(configPath(root))) {
    return emitJson({ error: { code: 'already-initialized', message: 'docs/tasks/.ptasks.json already exists' } }, 1);
  }
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeConfig(root, defaultConfig());
  const fs = createFsDestination({ root });
  await fs.ensureStructure();
  writeFileSync(join(root, 'docs', 'tasks', 'CLAUDE.md'), CLAUDE_MD_BODY, 'utf-8');
  writeFileSync(join(root, '.claude', 'rules', 'p-tasks.md'), RULE_BODY, 'utf-8');
  return emitJson({ ok: true, primary: 'fs', mirrors: [] }, 0);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  (async () => {
    if (process.argv[2] === '--version') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
    const command = process.argv[2];
    const args = parseArgs(process.argv.slice(3));
    const KNOWN = ['init', 'add', 'set', 'next', 'summary', 'sync'];
    if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
    if (command === 'init') {
      const root = findRoot(process.cwd());
      await initFs({ root });
      return;
    }
    die(`command ${command} not implemented yet`, 1);
  })();
}
