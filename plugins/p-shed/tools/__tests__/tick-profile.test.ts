import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { paths, writeJobs, writeJobState } from '../lib/io.mjs';

const MIN = 60000;
const NOW = new Date(2026, 6, 29, 9, 0).getTime();

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-tickprofile-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (o: Record<string, unknown> = {}) => ({
  runJob: vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 1, out: '', err: '' })),
  appendLog: vi.fn(), rotateLogs: vi.fn(), isPidAlive: vi.fn(() => false), writePid: vi.fn(), removePid: vi.fn(),
  ...o,
});

const jobs = (profiles: unknown, defaults: Record<string, unknown> = {}) => writeJobs(root, {
  version: 1, defaults, profiles,
  jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }],
});
const seed = () => writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
const writeConfig = (cfg: Record<string, unknown>) => {
  mkdirSync(paths(root).dir, { recursive: true });
  writeFileSync(paths(root).config, JSON.stringify(cfg), 'utf-8');
};
const withEnvProfile = async (value: string | undefined, fn: () => Promise<void>) => {
  const prev = process.env.PSHED_PROFILE;
  if (value === undefined) delete process.env.PSHED_PROFILE; else process.env.PSHED_PROFILE = value;
  try { await fn(); } finally { if (prev === undefined) delete process.env.PSHED_PROFILE; else process.env.PSHED_PROFILE = prev; }
};

describe('tick + speed profiles', () => {
  it('computes due-ness from the profile schedule, not the job schedule', async () => {
    // NOW is 09:00 and the job's own '* * * * *' is due; the eco slot (06:20) is not.
    jobs({ eco: { a: { schedule: '20 6 * * *' } } }, { profile: 'eco' });
    seed();
    const d = deps();
    expect(await tick({ root, now: NOW, deps: d })).toEqual([{ id: 'a', action: 'not-due' }]);
    expect(d.runJob).not.toHaveBeenCalled();
  });

  it('an override of enabled: false suppresses the launch entirely', async () => {
    jobs({ eco: { a: { enabled: false } } }, { profile: 'eco' });
    seed();
    const d = deps();
    expect(await tick({ root, now: NOW, deps: d })).toEqual([]);
    expect(d.runJob).not.toHaveBeenCalled();
  });

  it('passes the profile model / timeoutSec through to the launch', async () => {
    jobs({ eco: { a: { model: 'sonnet', timeoutSec: 90 } } }, { profile: 'eco' });
    seed();
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect((d.runJob as any).mock.calls[0][0].job).toMatchObject({ model: 'sonnet', timeoutSec: 90 });
  });

  it('PSHED_PROFILE overrides defaults.profile at tick time', async () => {
    jobs({ eco: { a: { enabled: false } }, fast: { a: { schedule: '* * * * *' } } }, { profile: 'eco' });
    seed();
    await withEnvProfile('fast', async () => {
      const d = deps();
      await tick({ root, now: NOW, deps: d });
      expect(d.runJob).toHaveBeenCalledOnce();
    });
  });

  it('reads the active profile from the file named by config.profileFile', async () => {
    jobs({ eco: { a: { enabled: false } } });
    writeFileSync(join(root, 'pace'), 'eco\n', 'utf-8');
    writeConfig({ profileFile: join(root, 'pace') });
    seed();
    const d = deps();
    expect(await tick({ root, now: NOW, deps: d })).toEqual([]);
    expect(d.runJob).not.toHaveBeenCalled();
  });

  // Fail toward running: every one of these is a profile problem, and none may stop the loop.
  it('an unknown profile name still ticks, at the job\'s own pace', async () => {
    jobs({ eco: { a: { enabled: false } } }, { profile: 'turbo' });
    seed();
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect(d.runJob).toHaveBeenCalledOnce();
  });

  it('a profileFile pointing at nothing still ticks', async () => {
    jobs({ eco: { a: { enabled: false } } });
    writeConfig({ profileFile: join(root, 'missing-profile') });
    seed();
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect(d.runJob).toHaveBeenCalledOnce();
  });

  it('an invalid override costs that field only', async () => {
    jobs({ eco: { a: { schedule: 'nonsense', model: 'sonnet' } } }, { profile: 'eco' });
    seed();
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect((d.runJob as any).mock.calls[0][0].job).toMatchObject({ schedule: '* * * * *', model: 'sonnet' });
  });

  it('a malformed profiles: block still ticks', async () => {
    jobs({ eco: 'not-a-map' }, { profile: 'eco' });
    seed();
    const d = deps();
    await tick({ root, now: NOW, deps: d });
    expect(d.runJob).toHaveBeenCalledOnce();
  });

  // The hard constraint, and the backwards-compatibility one.
  it('never rewrites jobs.yml', async () => {
    jobs({ eco: { a: { schedule: '0 */3 * * *' } } }, { profile: 'eco' });
    const before = readFileSync(paths(root).jobs, 'utf-8');
    seed();
    await tick({ root, now: NOW, deps: deps() });
    expect(readFileSync(paths(root).jobs, 'utf-8')).toBe(before);
  });

  it('a jobs.yml with no profiles: key behaves exactly as before', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    seed();
    const d = deps();
    expect(await tick({ root, now: NOW, deps: d })).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
  });
});
