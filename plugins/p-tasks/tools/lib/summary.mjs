import { parseId } from './schema.mjs';

export function summarize(items, opts = {}) {
  const parentId = opts.parentId;
  let pool;
  if (parentId === undefined) {
    pool = items.filter(i => i.type === 'task' && i.status === 'done');
  } else {
    const parent = items.find(i => i.id === parentId);
    if (!parent) throw new Error(`item ${parentId} not found`);
    pool = items.filter(i => i.type === 'sub-task' && i.parentId === parentId && i.status === 'done');
  }
  pool.sort((a, b) => {
    const pa = parseId(a.id), pb = parseId(b.id);
    if (!pa || !pb) return a.id.localeCompare(b.id);
    if (pa.prefix !== pb.prefix) return pa.prefix === 't' ? -1 : 1;
    return pa.n - pb.n;
  });
  return pool.map(i => {
    const r = { id: i.id, title: i.title };
    if (i.description) r.description = i.description;
    return r;
  });
}
