export const STATUSES = ['todo', 'in_progress', 'done'];
export const ID_PREFIXES = ['t', 'st'];
export const KINDS = ['code', 'non-code'];

export function parseId(id) {
  if (typeof id !== 'string') return null;
  const m = /^(t|st)-(\d+)$/.exec(id);
  if (!m) return null;
  return { prefix: m[1], n: Number(m[2]) };
}

export function formatId(prefix, n) {
  if (!ID_PREFIXES.includes(prefix)) throw new Error(`unknown prefix: ${prefix}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid n: ${n}`);
  return `${prefix}-${n}`;
}

export function validateItem(item) {
  if (!item || typeof item !== 'object') return { ok: false, error: 'item must be an object' };
  for (const f of ['id', 'type', 'title', 'description', 'status']) {
    if (!(f in item)) return { ok: false, error: `missing field: ${f}` };
  }
  if (typeof item.id !== 'string' || item.id.length === 0) return { ok: false, error: 'id must be non-empty string' };
  if (item.type !== 'task' && item.type !== 'sub-task') return { ok: false, error: `type must be "task" or "sub-task", got ${JSON.stringify(item.type)}` };
  if (typeof item.title !== 'string') return { ok: false, error: 'title must be a string' };
  if (typeof item.description !== 'string') return { ok: false, error: 'description must be a string' };
  if (!STATUSES.includes(item.status)) return { ok: false, error: `status must be one of ${STATUSES.join('/')}, got ${JSON.stringify(item.status)}` };
  if (!Array.isArray(item.blockedBy)) return { ok: false, error: 'blockedBy must be an array' };
  if (item.type === 'task' && !Array.isArray(item.subTasks)) return { ok: false, error: 'subTasks must be an array on a task' };
  const parsed = parseId(item.id);
  if (parsed) {
    if (parsed.prefix === 't' && item.type !== 'task') return { ok: false, error: `id ${item.id} is task-prefixed but type=${item.type}` };
    if (parsed.prefix === 'st' && item.type !== 'sub-task') return { ok: false, error: `id ${item.id} is sub-task-prefixed but type=${item.type}` };
  }
  // Optional work-item fields — type-checked only when present; never required,
  // so pre-existing tasks.yml files (which lack them entirely) stay valid.
  if ('acceptance' in item && typeof item.acceptance !== 'string') return { ok: false, error: 'acceptance must be a string' };
  if ('files' in item && (!Array.isArray(item.files) || item.files.some(f => typeof f !== 'string'))) return { ok: false, error: 'files must be an array of strings' };
  if ('kind' in item && !KINDS.includes(item.kind)) return { ok: false, error: `kind must be one of ${KINDS.join('/')}, got ${JSON.stringify(item.kind)}` };
  if ('origin' in item && typeof item.origin !== 'string') return { ok: false, error: 'origin must be a string' };
  if ('resolution' in item && typeof item.resolution !== 'string') return { ok: false, error: 'resolution must be a string' };
  return { ok: true };
}
