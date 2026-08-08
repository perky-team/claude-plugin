import { parseId } from './schema.mjs';

// How many ranked candidates `explain` reports. The cap keeps the envelope small for the
// prompt-driven callers that parse it; `candidateCount` carries the untruncated total, so
// a capped list is never mistaken for the whole queue. `excluded` is NEVER capped — a
// hidden exclusion is the exact thing --explain exists to surface.
export const EXPLAIN_RANKING_CAP = 10;

const COMPARATOR_DESCRIPTION =
  'in_progress first, then sub-task of an in-progress parent, then t- before st-, then numeric id';

/**
 * Rank the open, unblocked items and return the best one (or all of them).
 *
 * The ordering is `[statusRank, parentInProgressRank, prefixRank, num]`, lower wins on every
 * key. `statusRank` dominating is load-bearing anti-thrash behaviour, not an accident: a
 * scheduler-driven caller waking on a timer must continue what it already started rather
 * than abandon half-finished work whenever a lower-numbered item shows up.
 *
 * @param items
 * @param opts.all      true → every candidate in ranked order, else the top one or null
 * @param opts.explain  true → wrap the result as `{ selection, explain }`; see below
 * @param opts.onWarn   called once per item excluded by a blocker id that does not exist
 *
 * @returns Without `explain`: `item | null`, or `item[]` under `all` — unchanged, and
 *   depended on by `evaluateGuard`. With `explain`: `{ selection, explain }`, where
 *   `selection` is exactly what the call would otherwise have returned and `explain` is
 *   `{ comparator, ranking, candidateCount, excluded }`. `explain` describes the decision;
 *   it never influences it.
 */
export function pickNext(items, opts = {}) {
  const all = opts.all === true;
  const explain = opts.explain === true;
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

  const selection = all ? candidates : (candidates.length === 0 ? null : candidates[0]);
  if (!explain) return selection;

  // The explanation is DERIVED from the decision, never re-derived alongside it: `ranking`
  // calls the very `key` the sort above called, and `excluded` is a set difference against
  // the candidates that same loop produced. Neither can drift from the ordering, which is
  // the whole point — an explanation that computes the keys a second time is a second
  // implementation of the comparator, and it will disagree eventually.
  //
  // Set membership is by object identity, not by id: two items sharing an id would make an
  // id-keyed set claim the excluded one was a candidate.
  const chosen = new Set(candidates);
  const excluded = [];
  for (const it of items) {
    if (it.status === 'done' || chosen.has(it)) continue;
    // Deliberately without the hot loop's `break`. That loop stops at the first unsatisfied
    // blocker because that is all it needs in order to DECIDE; "what has to happen before
    // this becomes workable" needs all of them, or the caller clears the one blocker named
    // here, re-runs, and meets the next one. Order follows the item's own blockedBy, so a
    // cosmetic reordering of that array is the only thing that can reorder this one.
    //
    // No onWarn here: warnings belong to the decision path and must stay byte-identical.
    // A missing blocker reached only by this pass is therefore reported without a warning.
    const unsatisfiedBlockers = [];
    for (const b of it.blockedBy ?? []) {
      const target = byId.get(b);
      if (!target) unsatisfiedBlockers.push({ id: b, status: null, missing: true });
      else if (target.status !== 'done') unsatisfiedBlockers.push({ id: b, status: target.status });
    }
    excluded.push({ id: it.id, unsatisfiedBlockers });
  }

  return {
    selection,
    explain: {
      comparator: COMPARATOR_DESCRIPTION,
      ranking: candidates.slice(0, EXPLAIN_RANKING_CAP).map(it => {
        const [statusRank, parentInProgressRank, prefixRank, num] = key(it);
        return { id: it.id, key: { statusRank, parentInProgressRank, prefixRank, num } };
      }),
      candidateCount: candidates.length,
      excluded,
    },
  };
}
