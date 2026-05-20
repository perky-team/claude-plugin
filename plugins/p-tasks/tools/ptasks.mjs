#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { configPath, writeConfig, defaultConfig, validateConfig } from './lib/config.mjs';
import { createFsDestination } from './lib/destinations/fs.mjs';
import { createJiraDestination } from './lib/destinations/jira.mjs';
import { readConfig } from './lib/config.mjs';
import { resolveDestination } from './lib/destination.mjs';
import { findCycle } from './lib/cycles.mjs';
import { STATUSES } from './lib/schema.mjs';
import { pickNext } from './lib/next.mjs';
import { summarize } from './lib/summary.mjs';
import { syncAll } from './lib/sync.mjs';

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

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));

function loadTemplate(name) {
  return readFileSync(join(PLUGIN_ROOT, 'skills', '_shared', 'templates', name), 'utf-8');
}

function jiraBlockFromArgs(args) {
  const taskType = args['task-type'] ?? 'Task';
  const subTaskType = args['sub-task-type'] ?? 'Sub-task';
  return {
    kind: 'jira',
    siteUrl: args.site,
    projectKey: args.project,
    issueTypes: { task: taskType, subTask: subTaskType },
    statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' },
    jql: `project = ${args.project} AND issuetype in ("${taskType}", "${subTaskType}")`,
  };
}

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

export async function setCommand({ root, args }) {
  const id = args._[0];
  if (!id) return emitJson({ error: { code: 'internal', message: 'id required' } }, 1);

  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  const current = items.find(i => i.id === id);
  if (!current) return emitJson({ error: { code: 'item-not-found', message: `id ${id} not found` } }, 1);

  const patch = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.description !== undefined) patch.description = args.description;
  if (args.status !== undefined) {
    if (!STATUSES.includes(args.status)) return emitJson({ error: { code: 'invalid-status', message: `status must be one of ${STATUSES.join('/')}` } }, 1);
    patch.status = args.status;
  }

  let newBlockedBy = current.blockedBy.slice();
  let touchedBlockers = false;
  if (args['blocked-by'] !== undefined) {
    newBlockedBy = arrayify(args['blocked-by']);
    touchedBlockers = true;
  }
  for (const b of arrayify(args['add-blocker'])) {
    if (!newBlockedBy.includes(b)) newBlockedBy.push(b);
    touchedBlockers = true;
  }
  for (const b of arrayify(args['remove-blocker'])) {
    newBlockedBy = newBlockedBy.filter(x => x !== b);
    touchedBlockers = true;
  }

  if (touchedBlockers) {
    const ids = new Set(items.map(i => i.id));
    for (const b of newBlockedBy) {
      if (!ids.has(b)) return emitJson({ error: { code: 'blocker-not-found', message: `id ${b} not found` } }, 1);
    }
    const hypothetical = items.map(i => i.id === id ? { id, blockedBy: newBlockedBy } : { id: i.id, blockedBy: i.blockedBy });
    const cycle = findCycle(hypothetical);
    if (cycle) return emitJson({ error: { code: 'cycle-detected', message: `would create cycle: ${cycle.join(' → ')}` } }, 1);
    patch.blockedBy = newBlockedBy;
  }

  const updated = await primary.updateItem(id, patch);
  return emitJson(updated, 0);
}

export async function nextCommand({ root, args }) {
  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  const warns = [];
  if (args.all) {
    const list = pickNext(items, { all: true, onWarn: (m) => warns.push(m) });
    for (const w of warns) process.stderr.write(`warning: ${w}\n`);
    return emitJson({ items: list }, 0);
  }
  const one = pickNext(items, { onWarn: (m) => warns.push(m) });
  for (const w of warns) process.stderr.write(`warning: ${w}\n`);
  return emitJson({ next: one ?? null }, 0);
}

export async function summaryCommand({ root, args }) {
  const cfg = readConfig(root);
  const { primary } = resolveDestination({ root, config: cfg });
  await primary.ensureStructure();
  const items = await primary.listItems();
  const parentId = args._[0];
  try {
    const list = summarize(items, parentId ? { parentId } : {});
    return emitJson({ items: list }, 0);
  } catch (e) {
    return emitJson({ error: { code: 'item-not-found', message: e.message } }, 1);
  }
}

export async function initWithArgs({ root, args, transport }) {
  if (existsSync(configPath(root))) {
    return emitJson({ error: { code: 'already-initialized', message: 'docs/tasks/.ptasks.json already exists' } }, 1);
  }
  const primaryKind = args.primary ?? 'fs';
  const mirrorKind = args.mirror;

  const destinations = {};
  if (primaryKind === 'fs' || mirrorKind === 'fs') destinations.fs = { kind: 'fs' };
  if (primaryKind === 'jira' || mirrorKind === 'jira') {
    if (!process.env.PTASKS_JIRA_EMAIL || !process.env.PTASKS_JIRA_TOKEN) {
      return emitJson({ error: { code: 'auth-failed', message: 'PTASKS_JIRA_EMAIL and PTASKS_JIRA_TOKEN required' } }, 1);
    }
    if (!args.site || !args.project) {
      return emitJson({ error: { code: 'config-invalid', message: '--site and --project required for jira' } }, 1);
    }
    destinations.jira = jiraBlockFromArgs(args);
    const probe = createJiraDestination({
      block: destinations.jira,
      email: process.env.PTASKS_JIRA_EMAIL,
      token: process.env.PTASKS_JIRA_TOKEN,
      transport,
    });
    try { await probe.ensureStructure(); }
    catch (e) { return emitJson({ error: { code: 'config-invalid', message: e.message } }, 1); }
  }

  const cfg = {
    primary: primaryKind,
    mirrors: mirrorKind ? [mirrorKind] : [],
    destinations,
  };
  const v = validateConfig(cfg);
  if (!v.ok) return emitJson({ error: { code: 'internal', message: v.error } }, 1);

  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeConfig(root, cfg);
  if (destinations.fs) {
    const fs = createFsDestination({ root });
    await fs.ensureStructure();
  }
  writeFileSync(join(root, 'docs', 'tasks', 'CLAUDE.md'), loadTemplate('CLAUDE.md.tpl'), 'utf-8');
  writeFileSync(join(root, '.claude', 'rules', 'p-tasks.md'), loadTemplate('p-tasks.rule.md.tpl'), 'utf-8');
  return emitJson({ ok: true, primary: primaryKind, mirrors: cfg.mirrors }, 0);
}

// Backwards compatibility for the FS-only init test from Task 14
export async function initFs({ root }) {
  return initWithArgs({ root, args: {} });
}

export async function syncCommand({ root, args, transport }) {
  const cfg = readConfig(root);
  const resolved = resolveDestination({ root, config: cfg, transport });
  try {
    const results = await syncAll(resolved);
    const exitCode = results.some(r => r.errors.length > 0) ? 1 : 0;
    return emitJson({ mirrors: results }, exitCode);
  } catch (e) {
    return emitJson({ error: { code: e?.code ?? 'internal', message: e?.message ?? String(e) } }, 1);
  }
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
      await initWithArgs({ root, args });
      return;
    }
    if (command === 'add') {
      const root = findRoot(process.cwd());
      await addCommand({ root, args });
      return;
    }
    if (command === 'set') {
      const root = findRoot(process.cwd());
      await setCommand({ root, args });
      return;
    }
    if (command === 'next') {
      const root = findRoot(process.cwd());
      await nextCommand({ root, args });
      return;
    }
    if (command === 'summary') {
      const root = findRoot(process.cwd());
      await summaryCommand({ root, args });
      return;
    }
    if (command === 'sync') {
      const root = findRoot(process.cwd());
      await syncCommand({ root, args });
      return;
    }
    die(`command ${command} not implemented yet`, 1);
  })();
}
