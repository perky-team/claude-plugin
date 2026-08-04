import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProfile, effectiveJobs, profileFilePath, readProfileValue, resolveProfile, validateProfiles } from '../lib/profile.mjs';
import { ValidationError } from '../lib/jobs.mjs';

const TABLE = {
  eco: { worker: { schedule: '0 */3 * * *' }, planner: { enabled: false } },
  fast: { worker: { schedule: '0,30 * * * *' } },
};
const JOBS = [
  { id: 'worker', schedule: '* * * * *', prompt: 'w', enabled: true, model: 'opus' },
  { id: 'planner', schedule: '0 6 * * *', prompt: 'p', enabled: true },
];
const data = (over: Record<string, unknown> = {}) => ({ version: 1, defaults: {}, jobs: JOBS, profiles: TABLE, ...over });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-profile-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveProfile precedence', () => {
  it('env wins over file and default', () => {
    const f = join(root, 'p'); writeFileSync(f, 'fast\n');
    const r = resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: f }, env: { PSHED_PROFILE: 'eco' } });
    expect(r).toMatchObject({ name: 'eco', source: 'env' });
  });

  it('file wins over default, keeps only the first line, and names the file', () => {
    const f = join(root, 'p'); writeFileSync(f, '  fast  \nignored second line\n');
    const r = resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: f }, env: {} });
    expect(r).toMatchObject({ name: 'fast', source: 'file', file: f });
  });

  it('falls back to defaults.profile', () => {
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: {}, env: {} }))
      .toMatchObject({ name: 'eco', source: 'default' });
  });

  it('resolves to none when nothing is configured anywhere', () => {
    expect(resolveProfile({ root, jobsData: data(), config: {}, env: {} })).toMatchObject({ name: null, source: 'none' });
  });

  it('treats an empty or whitespace env var as unset', () => {
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: {}, env: { PSHED_PROFILE: '  ' } }))
      .toMatchObject({ name: 'eco', source: 'default' });
  });

  it('treats an empty file as "no choice yet" and falls through', () => {
    const f = join(root, 'p'); writeFileSync(f, '\n');
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: f }, env: {} }))
      .toMatchObject({ name: 'eco', source: 'default' });
  });

  it('warns but keeps a working profile when the configured file is missing', () => {
    const r = resolveProfile({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: { profileFile: join(root, 'nope') }, env: {} });
    expect(r).toMatchObject({ name: 'eco', source: 'default', warning: 'file-missing' });
  });

  it('a missing file with no default resolves to none, never to an error', () => {
    const r = resolveProfile({ root, jobsData: data(), config: { profileFile: join(root, 'nope') }, env: {} });
    expect(r).toMatchObject({ name: null, source: 'none', warning: 'file-missing' });
  });

  it('flags an unknown name as a problem rather than treating it as active', () => {
    const r = resolveProfile({ root, jobsData: data(), config: {}, env: { PSHED_PROFILE: 'turbo' } });
    expect(r).toMatchObject({ name: 'turbo', source: 'env', problem: 'unknown-name' });
  });

  it('flags an unknown defaults.profile too', () => {
    expect(resolveProfile({ root, jobsData: data({ defaults: { profile: 'turbo' } }), config: {}, env: {} }))
      .toMatchObject({ name: 'turbo', source: 'default', problem: 'unknown-name' });
  });

  it('resolves a relative profileFile against the root', () => {
    writeFileSync(join(root, 'rel'), 'fast\n');
    expect(resolveProfile({ root, jobsData: data(), config: { profileFile: 'rel' }, env: {} })).toMatchObject({ name: 'fast', source: 'file' });
  });

  it('works on a jobs.yml with no profiles: key at all', () => {
    expect(resolveProfile({ root, jobsData: { version: 1, defaults: {}, jobs: JOBS }, config: {}, env: {} }))
      .toEqual({ name: null, source: 'none' });
  });
});

describe('profileFilePath', () => {
  it('returns null when nothing is configured', () => {
    expect(profileFilePath(root, {})).toBeNull();
    expect(profileFilePath(root, { profileFile: '' })).toBeNull();
  });
  it('leaves an absolute path alone', () => {
    const abs = join(root, 'x');
    expect(profileFilePath(root, { profileFile: abs })).toBe(abs);
  });
});

describe('readProfileValue', () => {
  it('reads the first line, trimmed', () => {
    const f = join(root, 'p'); writeFileSync(f, '  eco  \nrest\n');
    expect(readProfileValue(f)).toBe('eco');
  });
  it('returns null for a missing file instead of throwing', () => {
    expect(readProfileValue(join(root, 'nope'))).toBeNull();
  });
});

describe('applyProfile', () => {
  it('layers the override over the job and leaves everything else alone', () => {
    const out = applyProfile(JOBS, TABLE, 'eco');
    expect(out[0]).toMatchObject({ id: 'worker', schedule: '0 */3 * * *', model: 'opus', prompt: 'w' });
    expect(out[1]).toMatchObject({ id: 'planner', enabled: false, schedule: '0 6 * * *' });
  });

  it('never mutates the input jobs', () => {
    applyProfile(JOBS, TABLE, 'eco');
    expect(JOBS[0].schedule).toBe('* * * * *');
    expect(JOBS[1].enabled).toBe(true);
  });

  it('ignores a profile entry naming a job that does not exist', () => {
    expect(applyProfile(JOBS, { eco: { ghost: { enabled: false } } }, 'eco').map(j => j.id)).toEqual(['worker', 'planner']);
  });

  it('drops an invalid override instead of halting, keeping the job base value', () => {
    const out = applyProfile(JOBS, { eco: { worker: { schedule: 'nonsense', effort: 'turbo', model: 'sonnet' } } }, 'eco');
    expect(out[0].schedule).toBe('* * * * *');
    expect(out[0].effort).toBeUndefined();
    expect(out[0].model).toBe('sonnet');
  });

  it('ignores unknown keys in an override — a profile is a pace control, not a second jobs.yml', () => {
    const out = applyProfile(JOBS, { eco: { worker: { prompt: 'hijacked', cwd: '/tmp' } } }, 'eco');
    expect(out[0].prompt).toBe('w');
    expect(out[0].cwd).toBeUndefined();
  });

  it('returns the jobs untouched for an unknown, null or malformed name', () => {
    expect(applyProfile(JOBS, TABLE, 'turbo')).toEqual(JOBS);
    expect(applyProfile(JOBS, TABLE, null)).toEqual(JOBS);
    expect(applyProfile(JOBS, { eco: 'nope' } as any, 'eco')).toEqual(JOBS);
  });
});

describe('validateProfiles', () => {
  it('accepts a well-formed table, an empty one and an absent one', () => {
    expect(() => validateProfiles(TABLE)).not.toThrow();
    expect(() => validateProfiles({})).not.toThrow();
    expect(() => validateProfiles(undefined)).not.toThrow();
  });

  it('names the profile, the job and the field of a bad value', () => {
    expect(() => validateProfiles({ eco: { worker: { effort: 'turbo' } } })).toThrow(/eco.*worker.*invalid effort/);
    expect(() => validateProfiles({ eco: { worker: { effort: 'turbo' } } })).toThrow(ValidationError);
  });

  it('rejects an invalid cron and a non-positive timeout', () => {
    expect(() => validateProfiles({ eco: { w: { schedule: 'nope' } } })).toThrow(/invalid cron/);
    expect(() => validateProfiles({ eco: { w: { timeoutSec: -1 } } })).toThrow(/invalid timeoutSec/);
  });

  it('rejects an unknown override key — a silent `schedul:` typo is the failure this feature exists to prevent', () => {
    expect(() => validateProfiles({ eco: { worker: { schedul: '* * * * *' } } })).toThrow(/schedul/);
  });

  it('rejects a malformed shape', () => {
    expect(() => validateProfiles({ eco: 'nope' })).toThrow(/eco/);
    expect(() => validateProfiles({ eco: { worker: 'nope' } })).toThrow(/worker/);
    expect(() => validateProfiles([] as any)).toThrow();
  });
});

describe('effectiveJobs', () => {
  it('applies the resolved profile', () => {
    const { jobs, profile } = effectiveJobs({ root, jobsData: data({ defaults: { profile: 'eco' } }), config: {}, env: {} });
    expect(profile).toMatchObject({ name: 'eco', source: 'default' });
    expect(jobs[0].schedule).toBe('0 */3 * * *');
    expect(jobs[1].enabled).toBe(false);
  });

  it('applies nothing when the name is unknown, and still returns every job', () => {
    const { jobs, profile } = effectiveJobs({ root, jobsData: data(), config: {}, env: { PSHED_PROFILE: 'turbo' } });
    expect(profile.problem).toBe('unknown-name');
    expect(jobs).toEqual(JOBS);
  });

  it('returns today\'s jobs untouched when no profile is configured', () => {
    const { jobs, profile } = effectiveJobs({ root, jobsData: data(), config: {}, env: {} });
    expect(jobs).toEqual(JOBS);
    expect(profile).toEqual({ name: null, source: 'none' });
  });
});
