import { pickNext } from './next.mjs';

// p-shed's guard contract: exit 0 → launch, exit 75 → deliberately quiet (not a
// failure, no history row), anything else → guard error counted toward the job's
// circuit breaker. 75 is sysexits' EX_TEMPFAIL, picked for the same reason p-chat
// picked it (`pchat.mjs`): no crashing tool emits it by accident, so a broken guard
// surfaces as an error instead of reading as eternal quiet.
export const GUARD_QUIET = 75;

const REASON_MAX = 100;

function oneLine(s) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 3)}...` : flat;
}

/**
 * Decide whether there is work worth launching a `claude -p` run for.
 *
 * Selection is `pickNext`'s and only `pickNext`'s — the guard filters its RESULT,
 * never its input. Dropping excluded items before the call would strip them from the
 * blocker map too, so a dependent of an excluded item would look blocked by a
 * non-existent id and vanish along with it.
 *
 * @param items    the full backlog, as `listItems()` returns it
 * @param opts.excludeOrigin  origin prefixes to skip (e.g. `human:` — items parked on
 *                            a person, which are open but no worker can advance)
 * @param opts.onWarn         forwarded to pickNext
 */
export function evaluateGuard(items, opts = {}) {
  const prefixes = (opts.excludeOrigin ?? []).filter(p => typeof p === 'string' && p.length > 0);
  const onWarn = opts.onWarn ?? (() => {});

  const open = items.filter(i => i.status !== 'done').length;
  const candidates = pickNext(items, { all: true, onWarn });
  const isExcluded = (it) => typeof it.origin === 'string' && prefixes.some(p => it.origin.startsWith(p));
  const actionable = candidates.filter(it => !isExcluded(it));

  const excluded = candidates.length - actionable.length;
  const blocked = open - candidates.length;
  const counts = { open, actionable: actionable.length, excluded, blocked };

  if (actionable.length > 0) {
    const next = actionable[0];
    return {
      result: 'ready',
      exit: 0,
      reason: oneLine(`ready: ${next.id} (${actionable.length} actionable of ${open} open)`),
      next,
      ...counts,
    };
  }

  let reason;
  if (open === 0) {
    reason = 'no work: nothing open';
  } else {
    const parts = [`${open} open`];
    if (excluded > 0) parts.push(`${excluded} excluded by origin`);
    if (blocked > 0) parts.push(`${blocked} blocked`);
    reason = `no work: ${parts.join(', ')}`;
  }
  return { result: 'quiet', exit: GUARD_QUIET, reason: oneLine(reason), next: null, ...counts };
}
