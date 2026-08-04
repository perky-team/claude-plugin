// Real-CLI e2e for `pshed profile`. The hard requirement — the ACTIVE profile value can
// live OUTSIDE the scheduled repository — is only provable by spawning the process and
// looking at where the bytes actually landed.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { paths, writeJobs } from '../lib/io.mjs';

vi.setConfig({ testTimeout: 30_000 });

const CLI = resolve(__dirname, '..', 'pshed.mjs');

function pshed(cwd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf-8', env: { ...process.env, PSHED_PROFILE: '', ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pshed-cliprofile-'));
  outside = mkdtempSync(join(tmpdir(), 'pshed-outside-'));
  writeJobs(root, {
    version: 1, defaults: {},
    jobs: [{ id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'go' }],
    profiles: { eco: { worker: { schedule: '0 */3 * * *' } }, fast: { worker: { schedule: '0,30 * * * *' } } },
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const config = (cfg: Record<string, unknown>) => {
  mkdirSync(paths(root).dir, { recursive: true });
  writeFileSync(paths(root).config, JSON.stringify(cfg), 'utf-8');
};

describe('CLI E2E: pshed profile', () => {
  it('list names the defined profiles', () => {
    const r = pshed(root, ['profile', 'list']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).profiles.sort()).toEqual(['eco', 'fast']);
  });

  it('show reports none when nothing is configured', () => {
    const r = pshed(root, ['profile', 'show']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'profile', name: null, source: 'none' });
  });

  it('set writes the name OUTSIDE the repo, leaves jobs.yml untouched, and show reads it back', () => {
    const file = join(outside, 'profile');
    config({ profileFile: file });
    const before = readFileSync(paths(root).jobs, 'utf-8');

    const set = pshed(root, ['profile', 'set', 'eco']);
    expect(set.status).toBe(0);
    expect(readFileSync(file, 'utf-8').trim()).toBe('eco');
    expect(readFileSync(paths(root).jobs, 'utf-8')).toBe(before);

    const show = JSON.parse(pshed(root, ['profile', 'show']).stdout);
    expect(show).toMatchObject({ name: 'eco', source: 'file', file });
    expect(show.jobs[0]).toMatchObject({ id: 'worker' });
    expect(show.jobs[0].changes.schedule).toMatchObject({ from: '* * * * *', to: '0 */3 * * *' });
  });

  it('set refuses when no profileFile is configured, and writes nothing', () => {
    const r = pshed(root, ['profile', 'set', 'eco']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/profileFile/);
    expect(existsSync(join(outside, 'profile'))).toBe(false);
  });

  it('set refuses an unknown name and lists the known ones', () => {
    config({ profileFile: join(outside, 'profile') });
    const r = pshed(root, ['profile', 'set', 'turbo']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/eco/);
    expect(existsSync(join(outside, 'profile'))).toBe(false);
  });

  it('set requires a name', () => {
    config({ profileFile: join(outside, 'profile') });
    expect(pshed(root, ['profile', 'set']).status).toBe(2);
  });

  it('PSHED_PROFILE beats the file, and show says which source won', () => {
    config({ profileFile: join(outside, 'profile') });
    pshed(root, ['profile', 'set', 'eco']);
    const show = JSON.parse(pshed(root, ['profile', 'show'], { PSHED_PROFILE: 'fast' }).stdout);
    expect(show).toMatchObject({ name: 'fast', source: 'env' });
  });

  it('show --human prints the source and the per-job resolution', () => {
    config({ profileFile: join(outside, 'profile') });
    pshed(root, ['profile', 'set', 'eco']);
    const out = pshed(root, ['profile', 'show', '--human']).stdout;
    expect(out).toContain('eco');
    expect(out).toContain('worker');
    expect(out).toContain('0 */3 * * *');
  });

  it('an invalid table fails the human-facing command with a precise message', () => {
    writeJobs(root, {
      version: 1, defaults: {}, jobs: [{ id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'go' }],
      profiles: { eco: { worker: { effort: 'turbo' } } },
    });
    const r = pshed(root, ['profile', 'list']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/eco.*worker.*invalid effort/);
  });

  it('an unknown subcommand is refused', () => {
    expect(pshed(root, ['profile', 'nope']).status).toBe(2);
  });

  it('status reports the active profile', () => {
    config({ profileFile: join(outside, 'profile') });
    pshed(root, ['profile', 'set', 'eco']);
    expect(JSON.parse(pshed(root, ['status']).stdout).profile).toMatchObject({ name: 'eco', source: 'file' });
  });

  it('status on a jobs.yml with no profiles: block has no profile key at all', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    expect(JSON.parse(pshed(root, ['status']).stdout).profile).toBeUndefined();
  });
});
