// End-to-end over the real CLI. wait-idle is the honest primitive: it changes NO state,
// so every assertion here also checks that run/PAUSED stayed absent.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-deploye2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const pshed = (...p: string[]) => join(root, '.pshed', ...p);
const cli = (args: string[]) => spawnSync('node', [CLI, ...args], { encoding: 'utf-8', cwd: root });

function writeJobs(yml: string) {
  mkdirSync(pshed(), { recursive: true });
  writeFileSync(pshed('jobs.yml'), yml, 'utf-8');
}
const TWO_JOBS = `version: 1
jobs:
  - id: worker
    schedule: "* * * * *"
    prompt: go
    concurrencyGroup: hft
  - id: chat
    schedule: "* * * * *"
    prompt: go
`;

// A live pidfile for a process that really exists, so isPidAlive says "busy".
function claimPid(id: string, pid = process.pid) {
  mkdirSync(pshed('run'), { recursive: true });
  writeFileSync(pshed('run', `${id}.pid`), String(pid), 'utf-8');
}

describe('wait-idle', () => {
  it('exits 0 immediately on an idle loop and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'wait-idle', idle: true, scope: 'global' });
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('exits 1 on timeout, names the holder, and still pauses nothing', () => {
    writeJobs(TWO_JOBS);
    claimPid('worker');
    const r = cli(['wait-idle', '--timeout-sec', '0', '--json']);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.idle).toBe(false);
    expect(out.holders).toEqual([{ id: 'worker', pid: process.pid }]);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('scopes to a group: a live job outside it does not count', () => {
    writeJobs(TWO_JOBS);
    claimPid('chat');                       // chat has no concurrencyGroup
    const r = cli(['wait-idle', '--group', 'hft', '--timeout-sec', '0', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).idle).toBe(true);
  });

  it('exits 2 on an unknown group and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--group', 'nope', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('validation');
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });
});
