import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasksDoc, dumpTasksDoc } from '../yaml.mjs';

const RELATIVE = 'docs/tasks/tasks.yml';

function tasksPath(root) { return join(root, RELATIVE); }

function readDoc(root) {
  const p = tasksPath(root);
  if (!existsSync(p)) return { tasks: [] };
  return loadTasksDoc(readFileSync(p, 'utf-8'));
}

function writeDoc(root, doc) {
  const p = tasksPath(root);
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  writeFileSync(p, dumpTasksDoc(doc), 'utf-8');
}

function flatten(doc) {
  const out = [];
  for (const t of doc.tasks ?? []) {
    out.push({ ...t, type: 'task' });
    for (const st of t.subTasks ?? []) {
      out.push({ ...st, type: 'sub-task', parentId: t.id });
    }
  }
  return out;
}

export function createFsDestination({ root, name = 'fs' }) {
  return {
    kind: 'fs',
    name,

    async ensureStructure() {
      if (!existsSync(tasksPath(root))) writeDoc(root, { tasks: [] });
    },

    async listItems() {
      return flatten(readDoc(root));
    },

    async readItem(id) {
      const all = flatten(readDoc(root));
      const it = all.find(i => i.id === id);
      if (!it) throw Object.assign(new Error(`item-not-found: ${id}`), { code: 'item-not-found' });
      return it;
    },

    async createItem() { throw new Error('not implemented yet'); },
    async updateItem() { throw new Error('not implemented yet'); },
  };
}
