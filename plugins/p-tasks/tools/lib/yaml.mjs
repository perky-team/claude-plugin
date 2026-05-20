import yaml from 'js-yaml';

const ITEM_KEY_ORDER = ['id', 'title', 'description', 'status', 'blockedBy', 'jiraKeys', 'subTasks'];

function orderItem(item) {
  const out = {};
  for (const k of ITEM_KEY_ORDER) {
    if (k in item) out[k] = k === 'subTasks' ? item.subTasks.map(orderItem) : item[k];
  }
  for (const k of Object.keys(item)) {
    if (!ITEM_KEY_ORDER.includes(k)) out[k] = item[k];
  }
  return out;
}

export function loadTasksDoc(text) {
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tasks)) {
    throw new Error('tasks.yml must have a top-level `tasks:` array');
  }
  return doc;
}

export function dumpTasksDoc(doc) {
  const ordered = { tasks: doc.tasks.map(orderItem) };
  return yaml.dump(ordered, { lineWidth: 120, noCompatMode: true });
}
