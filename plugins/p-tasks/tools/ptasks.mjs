#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, writeConfig, defaultConfig } from './lib/config.mjs';
import { createFsDestination } from './lib/destinations/fs.mjs';
import { readConfig } from './lib/config.mjs';
import { resolveDestination } from './lib/destination.mjs';
import { findCycle } from './lib/cycles.mjs';

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

function arrayify(v) {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export async function addCommand({ root, args }) {
  const type = args._[0];
  if (type !== 'task' && type !== 'sub-task') return emitJson({ error: { code: 'internal', message: 'first arg must be "task" or "sub-task"' } }, 1);
  const parentId = type === 'sub-task' ? args._[1] : undefined;
  if (type === 'sub-task' && !parentId) return emitJson({ error: { code: 'internal', message: 'sub-task requires <parent-id>' } }, 1);
  if (!args.title) return emitJson({ error: { code: 'internal', message: '--title required' } }, 1);

  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();

  const blockedBy = arrayify(args['blocked-by']);
  const existing = await primary.listItems();
  const ids = new Set(existing.map(i => i.id));
  for (const b of blockedBy) {
    if (!ids.has(b)) return emitJson({ error: { code: 'blocker-not-found', message: `id ${b} not found` } }, 1);
  }

  // cycle check: hypothetically add a new id with these blockers and run findCycle
  const newId = `__pending__`;
  const hypothetical = existing.map(i => ({ id: i.id, blockedBy: i.blockedBy }))
    .concat([{ id: newId, blockedBy }]);
  const cycle = findCycle(hypothetical);
  if (cycle && cycle.includes(newId)) {
    return emitJson({ error: { code: 'cycle-detected', message: `would create cycle: ${cycle.join(' → ')}` } }, 1);
  }

  const created = await primary.createItem({
    type,
    parentId,
    title: args.title,
    description: args.description ?? '',
    status: args.status ?? 'todo',
    blockedBy,
  });
  return emitJson(created, 0);
}

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
    if (command === 'add') {
      const root = findRoot(process.cwd());
      await addCommand({ root, args });
      return;
    }
    die(`command ${command} not implemented yet`, 1);
  })();
}
