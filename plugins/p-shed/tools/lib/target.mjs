// Target resolution for `pause` / `resume`: no flags = the whole scheduler, `--id` =
// one job, `--group` = every member of one concurrency group.
//
// Everything here exists to make an unrecognised target LOUD. `pshed pause --id worker`
// used to ignore the flag and halt the entire scheduler — chat jobs included — while
// answering {"action":"pause","paused":true}. Widening a blast radius on a typo is the
// opposite of what `rm-job` does (it errors on a missing --id), so an unknown job, an
// unmatched group, both flags at once, or a valueless flag (parseArgs yields boolean
// `true`) all throw instead of falling back to the global marker.
import { ValidationError } from './jobs.mjs';
import { resolveGroup } from './concurrency.mjs';

const named = (v) => v !== undefined && v !== null && v !== false;

export function resolveTarget({ jobs = [], defaults = {}, id, group } = {}) {
  const wantsJob = named(id);
  const wantsGroup = named(group);

  if (wantsJob && wantsGroup) {
    throw new ValidationError('--id and --group are mutually exclusive: pause one job or one group, not both');
  }
  if (!wantsJob && !wantsGroup) return null; // global scope — today's behavior, unchanged

  if (wantsJob) {
    if (typeof id !== 'string' || id.trim() === '') throw new ValidationError('--id requires a job id');
    const wanted = id.trim();
    if (!jobs.some((j) => j?.id === wanted)) throw new ValidationError(`no such job: ${wanted}`);
    return { scope: 'job', id: wanted, ids: [wanted] };
  }

  if (typeof group !== 'string' || group.trim() === '') throw new ValidationError('--group requires a concurrency group name');
  const wanted = group.trim();
  // Membership comes from resolveGroup, so `defaults.concurrencyGroup` inheritance and
  // a job's explicit `null` opt-out behave exactly as they do in the tick's group gate.
  const ids = jobs.filter((j) => resolveGroup(j, defaults) === wanted).map((j) => j.id);
  if (ids.length === 0) throw new ValidationError(`no jobs in concurrency group: ${wanted}`);
  return { scope: 'group', group: wanted, ids };
}
