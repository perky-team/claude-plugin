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

  it('rejects --id (not allowed) and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--id', 'worker', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('validation');
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('rejects valueless --timeout-sec and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--timeout-sec', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('validation');
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('rejects valueless --poll-ms and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--poll-ms', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('validation');
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });
});

describe('deploy', () => {
  const NODE = process.execPath;

  it('runs the command, propagates its exit code, and leaves nothing paused', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'prompt update', '--', NODE, '-e', 'process.exit(0)']);
    expect(r.status).toBe(0);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('propagates a non-zero exit code and still releases', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'prompt update', '--', NODE, '-e', 'process.exit(17)']);
    expect(r.status).toBe(17);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('passes a command carrying its own flags through untouched', () => {
    writeJobs(TWO_JOBS);
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const r = cli(['deploy', '--reason', 'x', '--', NODE, '-e', script, '--', '--json', '--group', 'not-ours']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"--json"');
    expect(r.stdout).toContain('"--group"');
    // p-shed's report must be human-readable (not JSON), proving --json went to the script, not to p-shed
    expect(() => JSON.parse(r.stderr)).toThrow();
  });

  it('keeps its own report out of the command stdout', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--json', '--', NODE, '-e', 'console.log("COMMAND-OUTPUT")']);
    expect(r.stdout.trim()).toBe('COMMAND-OUTPUT');
    expect(JSON.parse(r.stderr)).toMatchObject({ action: 'deploy', outcome: 'ok', exit: 0 });
  });

  it('exits 2 on --id and pauses nothing', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--id', 'worker', '--json', '--', NODE, '-e', '0']);
    expect(r.status).toBe(2);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('exits 2 without --reason, without -- and without a command', () => {
    writeJobs(TWO_JOBS);
    expect(cli(['deploy', '--json', '--', NODE, '-e', '0']).status).toBe(2);
    expect(cli(['deploy', '--reason', 'x', '--json']).status).toBe(2);
    expect(cli(['deploy', '--reason', 'x', '--json', '--']).status).toBe(2);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('exits 1 on timeout: nothing paused, nothing run', () => {
    writeJobs(TWO_JOBS);
    claimPid('worker');
    const r = cli(['deploy', '--reason', 'x', '--timeout-sec', '0', '--json', '--', NODE, '-e', 'console.log("MUST-NOT-RUN")']);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('MUST-NOT-RUN');
    expect(JSON.parse(r.stderr)).toMatchObject({ action: 'deploy', outcome: 'timeout' });
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('releases even when the command cannot be spawned at all', () => {
    // The exit code differs by platform and that is inherent, not a bug: measured, with
    // shell:true (win32) a missing binary is reported by the shell as exit 1, while a
    // shell-less POSIX spawn raises ENOENT, which maps to the conventional 127. What must
    // hold on BOTH is that the loop is left un-paused.
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--json', '--', 'definitely-not-a-real-binary-xyz']);
    expect(r.status).toBe(process.platform === 'win32' ? 1 : 127);
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('run/DEPLOY creates no phantom job in status and none in stop --kill', () => {
    writeJobs(TWO_JOBS);
    mkdirSync(pshed('run'), { recursive: true });
    writeFileSync(pshed('run', 'DEPLOY'), JSON.stringify({ pid: process.pid, scope: 'global' }), 'utf-8');

    const st = JSON.parse(cli(['status', '--json']).stdout);
    expect(st.jobs.map((j: any) => j.id).sort()).toEqual(['chat', 'worker']);

    // stop --kill enumerates run/*.pid and terminates each as a job. A DEPLOY file that
    // leaked into that list would make the teardown try to kill the deploying process.
    const stopped = JSON.parse(cli(['stop', '--kill', '--json']).stdout);
    expect(stopped.killed).toEqual({ terminated: 0, ids: [] });
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(true);
  });
});

// POSIX only: measured, a Node process on Windows receives neither SIGINT nor SIGTERM —
// the handler never fires — so there is nothing to assert there. The reclaim in the tick
// is what covers Windows, and owner.test.ts covers the reclaim.
describe.skipIf(process.platform === 'win32')('deploy releases on a signal', () => {
  it('SIGINT during the command still clears the pause and run/DEPLOY', async () => {
    writeJobs(TWO_JOBS);
    const { spawn } = await import('node:child_process');
    const child = spawn('node', [CLI, 'deploy', '--reason', 'x', '--', process.execPath, '-e', 'setTimeout(()=>{},10000)'], { cwd: root, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(true);   // paused while it runs
    child.kill('SIGINT');
    await new Promise((r) => child.on('exit', r));
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  }, 20_000);
});
