import { parseId } from './schema.mjs';

export function pickNext(items, opts = {}) {
  const all = opts.all === true;
  const onWarn = opts.onWarn ?? (() => {});

  const byId = new Map(items.map(i => [i.id, i]));
  const candidates = [];
  for (const it of items) {
    if (it.status === 'done') continue;
    let satisfied = true;
    for (const b of it.blockedBy ?? []) {
      const target = byId.get(b);
      if (!target) {
        onWarn(`item ${it.id}: blocker ${b} does not exist; excluding from next`);
        satisfied = false;
        break;
      }
      if (target.status !== 'done') { satisfied = false; break; }
    }
    if (satisfied) candidates.push(it);
  }

  function key(it) {
    const statusRank = it.status === 'in_progress' ? 0 : 1;
    let parentInProgressRank = 1;
    if (it.type === 'sub-task' && it.parentId) {
      const parent = byId.get(it.parentId);
      if (parent && parent.status === 'in_progress') parentInProgressRank = 0;
    }
    const parsed = parseId(it.id);
    const prefixRank = parsed?.prefix === 't' ? 0 : 1;
    const num = parsed?.n ?? Number.MAX_SAFE_INTEGER;
    return [statusRank, parentInProgressRank, prefixRank, num];
  }

  candidates.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });

  if (all) return candidates;
  return candidates.length === 0 ? null : candidates[0];
}
