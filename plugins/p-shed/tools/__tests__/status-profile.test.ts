import { describe, expect, it } from 'vitest';
import { collectStatus, formatHuman } from '../lib/status.mjs';

const JOBS = [
  { id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'w' },
  { id: 'planner', schedule: '0 6 * * *', enabled: true, prompt: 'p' },
];

const deps = (jobsData: Record<string, unknown>, config: Record<string, unknown> = {}) => ({
  readJobs: () => ({ version: 1, defaults: {}, jobs: JOBS, profiles: {}, ...jobsData }),
  readConfig: () => config,
  readJobState: () => ({ lastRun: 1 }),
  readPauseRecord: () => null,
  readGlobalPause: () => null,
  readPid: () => null,
  isPidAlive: () => false,
});

const status = (jobsData: Record<string, unknown>, config: Record<string, unknown> = {}) =>
  collectStatus('/nowhere', { installed: false, deps: deps(jobsData, config) });

describe('status + speed profiles', () => {
  it('reports the EFFECTIVE enabled flag, not the raw one', () => {
    const s = status({ defaults: { profile: 'eco' }, profiles: { eco: { planner: { enabled: false } } } });
    expect(s.jobs.find((j: any) => j.id === 'planner').enabled).toBe(false);
    expect(s.profile).toMatchObject({ name: 'eco', source: 'default' });
  });

  it('shows the active profile and its source in the human header', () => {
    const text = formatHuman(status({ defaults: { profile: 'eco' }, profiles: { eco: {} } }), 1);
    expect(text).toMatch(/^profile: +eco \(default\)$/m);
    // still above the table, next to paused:
    expect(text.indexOf('profile:')).toBeLessThan(text.indexOf('id\t'));
  });

  it('names the file when the value came from one', () => {
    const s = status({ profiles: { eco: {} } }, { profileFile: '/var/lib/pshed/profile' });
    expect(s.profile).toMatchObject({ source: 'none', file: expect.stringContaining('profile') });
  });

  it('surfaces an unknown name instead of pretending it is active', () => {
    const s = status({ defaults: { profile: 'turbo' }, profiles: { eco: { worker: { enabled: false } } } });
    expect(s.profile).toMatchObject({ name: 'turbo', problem: 'unknown-name' });
    expect(s.jobs.find((j: any) => j.id === 'worker').enabled).toBe(true); // not applied
    expect(formatHuman(s, 1)).toContain('unknown-name');
  });

  it('surfaces a broken profileFile as a warning', () => {
    const s = status({ defaults: { profile: 'eco' }, profiles: { eco: {} } }, { profileFile: '/nowhere/at/all/profile' });
    expect(s.profile).toMatchObject({ name: 'eco', warning: 'file-missing' });
    expect(formatHuman(s, 1)).toContain('file-missing');
  });

  it("omits the profile entirely when none is configured — today's output, unchanged", () => {
    const s = status({});
    expect(s.profile).toBeUndefined();
    expect(formatHuman(s, 1)).not.toContain('profile:');
  });
});
