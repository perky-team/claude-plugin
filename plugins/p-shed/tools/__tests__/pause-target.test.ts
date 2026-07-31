// Target resolution for `pause`/`resume`. The whole point of this module is that an
// unrecognised or unmatched target THROWS: `pshed pause --id worker` used to ignore the
// flag and halt the entire scheduler, chat jobs included, while reporting success.
import { describe, expect, it } from 'vitest';
import { resolveTarget } from '../lib/target.mjs';
import { ValidationError } from '../lib/jobs.mjs';

const jobs = [
  { id: 'worker', concurrencyGroup: 'tree' },
  { id: 'inheritor' },                        // takes 'tree' from defaults
  { id: 'loner', concurrencyGroup: null },    // explicit opt-out beats defaults
  { id: 'chat', concurrencyGroup: 'chat' },
];
const defaults = { concurrencyGroup: 'tree' };

describe('resolveTarget', () => {
  it('returns null (global scope) when neither flag is given', () => {
    expect(resolveTarget({ jobs, defaults })).toBeNull();
  });

  it('resolves a known job id', () => {
    expect(resolveTarget({ jobs, defaults, id: 'worker' })).toEqual({ scope: 'job', id: 'worker', ids: ['worker'] });
  });

  it('resolves a group to its members, including one inheriting from defaults', () => {
    expect(resolveTarget({ jobs, defaults, group: 'tree' })).toEqual({
      scope: 'group', group: 'tree', ids: ['worker', 'inheritor'], // jobs.yml order
    });
  });

  it('excludes a job whose explicit null opts out of the default group', () => {
    expect(resolveTarget({ jobs, defaults, group: 'tree' }).ids).not.toContain('loner');
  });

  it('rejects an unknown job id', () => {
    expect(() => resolveTarget({ jobs, defaults, id: 'nope' })).toThrow(ValidationError);
    expect(() => resolveTarget({ jobs, defaults, id: 'nope' })).toThrow(/no such job/);
  });

  it('rejects a group no job belongs to', () => {
    expect(() => resolveTarget({ jobs, defaults, group: 'ghosts' })).toThrow(ValidationError);
    expect(() => resolveTarget({ jobs, defaults, group: 'ghosts' })).toThrow(/group/);
  });

  it('rejects --id and --group together', () => {
    expect(() => resolveTarget({ jobs, defaults, id: 'worker', group: 'tree' })).toThrow(ValidationError);
  });

  // parseArgs turns a valueless `--id` into boolean true. That must be an error: it is
  // the exact shape that used to fall through to a global pause.
  it('rejects a valueless --id / --group (parsed as boolean true)', () => {
    expect(() => resolveTarget({ jobs, defaults, id: true })).toThrow(ValidationError);
    expect(() => resolveTarget({ jobs, defaults, group: true })).toThrow(ValidationError);
  });

  it('rejects an empty-string target rather than widening to global', () => {
    expect(() => resolveTarget({ jobs, defaults, id: '' })).toThrow(ValidationError);
    expect(() => resolveTarget({ jobs, defaults, group: '  ' })).toThrow(ValidationError);
  });

  it('with no jobs at all, a targeted pause is an error (never a global one)', () => {
    expect(() => resolveTarget({ jobs: [], defaults: {}, id: 'worker' })).toThrow(ValidationError);
  });
});
