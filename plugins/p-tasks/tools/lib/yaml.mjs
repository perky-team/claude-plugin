// Vendored, not a bare `import 'js-yaml'`: plugins ship as a plain file copy
// with no install step, so the dependency must live inside the artifact.
// Regenerate with scripts/vendor-deps.mjs. See README "Dependency shipping".
import yaml from './vendor/js-yaml.mjs';

const ITEM_KEY_ORDER = ['id', 'title', 'description', 'status', 'acceptance', 'files', 'kind', 'origin', 'resolution', 'blockedBy', 'jiraKeys', 'subTasks'];

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
  // Preserve any non-`tasks` top-level keys a user may have added so a
  // read→mutate→write cycle doesn't silently discard them.
  const { tasks, ...rest } = doc;
  const ordered = { tasks: (tasks ?? []).map(orderItem), ...rest };
  return yaml.dump(ordered, { lineWidth: 120, noCompatMode: true });
}
