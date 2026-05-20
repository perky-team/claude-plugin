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

    async createItem(input) {
      const doc = readDoc(root);
      const flat = flatten(doc);

      if (input.type === 'sub-task') {
        const parent = doc.tasks.find(t => t.id === input.parentId);
        if (!parent) throw Object.assign(new Error(`parent-not-found: ${input.parentId}`), { code: 'parent-not-found' });
      }

      const prefix = input.type === 'task' ? 't' : 'st';
      let maxN = 0;
      for (const i of flat) {
        const m = new RegExp(`^${prefix}-(\\d+)$`).exec(i.id);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
      const id = `${prefix}-${maxN + 1}`;

      const base = {
        id,
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'todo',
        blockedBy: input.blockedBy ?? [],
      };

      if (input.type === 'task') {
        doc.tasks.push({ ...base, subTasks: [] });
        writeDoc(root, doc);
        return { ...base, type: 'task', subTasks: [] };
      } else {
        const parent = doc.tasks.find(t => t.id === input.parentId);
        parent.subTasks = parent.subTasks ?? [];
        parent.subTasks.push(base);
        writeDoc(root, doc);
        return { ...base, type: 'sub-task', parentId: input.parentId };
      }
    },
    async updateItem(id, patch) {
      const doc = readDoc(root);
      let found = null;
      let parentForSub = null;
      for (const t of doc.tasks) {
        if (t.id === id) { found = t; break; }
        if (t.subTasks) {
          for (const st of t.subTasks) {
            if (st.id === id) { found = st; parentForSub = t; break; }
          }
          if (found) break;
        }
      }
      if (!found) throw Object.assign(new Error(`item-not-found: ${id}`), { code: 'item-not-found' });

      for (const k of ['title', 'description', 'status']) {
        if (k in patch) found[k] = patch[k];
      }
      if ('blockedBy' in patch) found.blockedBy = patch.blockedBy;
      if ('jiraKeys' in patch) {
        found.jiraKeys = { ...(found.jiraKeys ?? {}), ...patch.jiraKeys };
      }

      writeDoc(root, doc);
      if (parentForSub) return { ...found, type: 'sub-task', parentId: parentForSub.id };
      return { ...found, type: 'task' };
    },
  };
}
