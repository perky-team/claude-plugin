// Walk the whole plan. `next` returns only open items and `summary` only done
// ones; `list` returns ALL items in document order with their status and the
// optional work-item fields, so a consumer (e.g. p-flow's executing-plan) can
// walk every step regardless of state.

const OPTIONAL = ['acceptance', 'files', 'kind', 'origin', 'resolution'];

function project(item) {
  const r = { id: item.id, type: item.type, title: item.title, status: item.status };
  if (item.parentId) r.parentId = item.parentId;
  if (item.description) r.description = item.description;
  for (const k of OPTIONAL) {
    if (item[k] !== undefined) r[k] = item[k];
  }
  if (Array.isArray(item.blockedBy) && item.blockedBy.length > 0) r.blockedBy = item.blockedBy;
  return r;
}

export function listAll(items, opts = {}) {
  const parentId = opts.parentId;
  if (parentId === undefined) {
    // `items` already arrives in document order (task, then its sub-tasks).
    return items.map(project);
  }
  const parent = items.find(i => i.id === parentId);
  if (!parent) throw new Error(`item ${parentId} not found`);
  return items.filter(i => i.type === 'sub-task' && i.parentId === parentId).map(project);
}
