// End-to-end over the real CLI. wait-idle is the honest primitive: it changes NO state,
// so every assertion here also checks that run/PAUSED stayed absent.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDeploy, formatWaitIdle, quoteWinArg } from '../pshed.mjs';

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

// Unit-level, not e2e: 'aborted' is what runDeploy reports when Ctrl+C lands during the
// wait (see lib/deploy.mjs, waited.aborted branch) — nothing was paused, nothing ran,
// pausedIds is [] and ownedGlobal is false on that path. Exercising this honestly through
// a real signal would be POSIX-only (measured: Windows delivers neither SIGINT nor SIGTERM
// to a Node handler — see the skipIf block below), so formatDeploy is tested directly
// against the exact shape runDeploy produces, which keeps this test meaningful on every
// platform instead of adding a second always-skipped-on-Windows case.
describe('formatDeploy', () => {
  it('reports an interrupted-during-wait deploy honestly: no pause claimed, no command run claimed', () => {
    const report = {
      action: 'deploy',
      outcome: 'aborted',
      exit: 130,
      waitedMs: 12_345,
      attempts: 1,
      scope: 'global',
      group: null,
      pausedIds: [],
      ownedGlobal: false,
      preserved: [],
      holders: [{ id: 'worker', pid: 111 }],
      releaseErrors: [],
    };
    const text = formatDeploy(report);
    // "nothing paused, nothing run" is the honest claim (see the timeout branch, which
    // uses identical wording) — what must NOT appear is the generic branch's false claims
    // that something WAS paused, a command exited, or a release happened.
    expect(text).not.toMatch(/paused (the scheduler|group)/i);
    expect(text).not.toMatch(/command exited/i);
    expect(text).not.toMatch(/, released/i);
    expect(text).toMatch(/nothing paused, nothing run/i);
  });

  // M2: the 'ok' branch used to claim "paused the scheduler ... released" unconditionally,
  // even when this run walked into an existing pause and OWNED NOTHING (ownedGlobal:
  // false, ever preserved). It paused and released nothing — same false-report shape the
  // 'aborted' branch above exists to avoid, just for a different outcome.
  it('reports honestly when the run walked into an existing global pause and released nothing', () => {
    const report = {
      action: 'deploy', outcome: 'ok', exit: 0, waitedMs: 0, attempts: 1,
      scope: 'global', group: null, pausedIds: [], ownedGlobal: false,
      preserved: [{ scope: 'global' }], releaseErrors: [],
    };
    const text = formatDeploy(report);
    expect(text).not.toMatch(/paused the scheduler/i);
    expect(text).not.toMatch(/, released/i);
    expect(text).toMatch(/found the scheduler already paused/i);
  });

  it('still reports the honest paused/released claim when this run genuinely owned the global pause', () => {
    const report = {
      action: 'deploy', outcome: 'ok', exit: 0, waitedMs: 3, attempts: 1,
      scope: 'global', group: null, pausedIds: [], ownedGlobal: true,
      preserved: [], releaseErrors: [],
    };
    const text = formatDeploy(report);
    expect(text).toMatch(/paused the scheduler/i);
    expect(text).toMatch(/, released/i);
  });

  it('group scope: reports members actually paused, distinct from ones only preserved', () => {
    const report = {
      action: 'deploy', outcome: 'ok', exit: 0, waitedMs: 1, attempts: 1,
      scope: 'group', group: 'hft', pausedIds: ['worker'], ownedGlobal: false,
      preserved: [{ scope: 'job', id: 'chat', origin: 'operator' }], releaseErrors: [],
    };
    const text = formatDeploy(report);
    expect(text).toMatch(/paused 1 member\(s\) of group hft/i);
    expect(text).toMatch(/, released/i);
    expect(text).toMatch(/kept 1 pre-existing pause\(s\)/i);
  });

  it('group scope: every member already paused — nothing owned, nothing released', () => {
    const report = {
      action: 'deploy', outcome: 'ok', exit: 0, waitedMs: 1, attempts: 1,
      scope: 'group', group: 'hft', pausedIds: [], ownedGlobal: false,
      preserved: [{ scope: 'job', id: 'worker', origin: 'operator' }, { scope: 'job', id: 'chat', origin: 'operator' }],
      releaseErrors: [],
    };
    const text = formatDeploy(report);
    expect(text).not.toMatch(/, released/i);
    expect(text).toMatch(/found group hft already paused/i);
  });

  // C1: a second deploy refused outright before ever touching run/DEPLOY or a pause.
  it('reports a refusal by name — the holder pid and reason, nothing paused or run', () => {
    const report = {
      action: 'deploy', outcome: 'busy', exit: 2, waitedMs: 0, attempts: 0,
      scope: 'global', group: null, pausedIds: [], ownedGlobal: false, preserved: [],
      holder: { pid: 1234, reason: 'prompt update' },
      message: 'another deploy is in progress (pid 1234, reason "prompt update")',
    };
    const text = formatDeploy(report);
    expect(text).toMatch(/refused/i);
    expect(text).toMatch(/pid 1234/);
    expect(text).toMatch(/"prompt update"/);
    expect(text).toMatch(/nothing paused, nothing run/i);
  });
});

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

  // M9: without --json the output used to be JSON regardless — the flag was inert.
  // `deploy`, wait-idle's sibling operator command, already toggles genuinely on
  // presence/absence of --json, so wait-idle now mirrors it instead of leaving the flag
  // documented but meaningless.
  it('without --json prints a human-readable line, not JSON', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle']);
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).toThrow();
    expect(r.stdout).toMatch(/idle/i);
  });

  it('still honours --json exactly as before when it IS passed', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['wait-idle', '--json']);
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('formatWaitIdle names the holders on a timeout, mirroring formatDeploy', () => {
    const report = { action: 'wait-idle', idle: false, scope: 'global', group: null, waitedMs: 4200, holders: [{ id: 'worker', pid: 111 }] };
    expect(formatWaitIdle(report)).toMatch(/timed out after 4s/);
    expect(formatWaitIdle(report)).toMatch(/worker \(pid 111\)/);
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

  // Regression for the win32 spawnInherit escaping: the old regex doubled EVERY backslash
  // unconditionally, which is not how CommandLineToArgvW parses a command line (a run of
  // backslashes is only special immediately before a quote or at the end of the argument).
  // A literal `C:\Users\...` path has no quote following its backslashes, so doubling them
  // corrupted the value the deployed command actually received. This is why the existing
  // deploy tests (single-token args, no backslashes/spaces/metacharacters) never caught it.
  // On POSIX this exercises the shell-less array-based branch instead, which was never
  // broken, so the same assertion must hold on both platforms.
  it('round-trips a Windows-hostile argument set to the deployed command, byte-identical', () => {
    writeJobs(TWO_JOBS);
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const payload = ['C:\\Users\\test\\file.txt', 'hello world', 'a&b'];
    const r = cli(['deploy', '--reason', 'x', '--', NODE, '-e', script, '--', ...payload]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(payload);
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

  // M1: deploy's own spawn/timeout/aborted outcomes were already reported on stderr, but
  // validation errors still went through the generic emitJson path onto STDOUT — the
  // exact channel this command exists to keep clean for the deployed command. The
  // reviewers' literal reproduction: a shell redirect of deploy's stdout (`> sha.txt`)
  // ends up holding a JSON error blob instead of staying empty, because the command never
  // even starts. `--timeout-sec abc` fails inside timeoutMsFrom (a ValidationError thrown
  // well after the four explicit --id/--reason/--/command checks), so this also proves
  // the fix isn't just those four checks but the whole validation surface.
  it('a non-numeric --timeout-sec reports on stderr, not stdout, honouring --json', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--timeout-sec', 'abc', '--json', '--', NODE, '-e', 'console.log("MUST-NOT-RUN")']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe(''); // nothing — not even a stray newline — reaches stdout
    expect(r.stdout).not.toContain('MUST-NOT-RUN'); // the command never even ran
    const report = JSON.parse(r.stderr);
    expect(report.error.code).toBe('validation');
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
  });

  it('the same validation failure without --json is human text on stderr, still not stdout', () => {
    writeJobs(TWO_JOBS);
    const r = cli(['deploy', '--reason', 'x', '--timeout-sec', 'abc', '--', NODE, '-e', '0']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(() => JSON.parse(r.stderr)).toThrow();
    expect(r.stderr).toMatch(/timeout-sec/);
  });

  it('the --id / --reason / missing-command validation errors also stay off stdout', () => {
    writeJobs(TWO_JOBS);
    const withId = cli(['deploy', '--reason', 'x', '--id', 'worker', '--json', '--', NODE, '-e', '0']);
    expect(withId.stdout).toBe('');
    expect(JSON.parse(withId.stderr).error.code).toBe('validation');

    const noReason = cli(['deploy', '--json', '--', NODE, '-e', '0']);
    expect(noReason.stdout).toBe('');
    expect(JSON.parse(noReason.stderr).error.code).toBe('validation');

    const noCommand = cli(['deploy', '--reason', 'x', '--json']);
    expect(noCommand.stdout).toBe('');
    expect(JSON.parse(noCommand.stderr).error.code).toBe('validation');
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

// C1: the blocker itself, reproduced with two REAL OS processes — same as the two
// independent reviewers who found it (one reading the code, one driving the live CLI).
// Deploy A holds run/DEPLOY with a live pid while its command is still running; deploy B
// must refuse outright instead of overwriting A's ownership and running its own command
// alongside A's. This is the scenario the unit-level tests in deploy.test.ts also cover,
// but only real concurrent processes prove the fix holds against the actual timeline —
// no crash, no signal, no kill, just two overlapping `deploy` invocations.
describe('C1 — a second deploy refuses while a real first deploy is still running', () => {
  const NODE = process.execPath;

  it("does not disturb the first deploy's ownership or pause, and never runs its own command", async () => {
    writeJobs(TWO_JOBS);
    const { spawn } = await import('node:child_process');
    // Deploy A: a short-lived command, just long enough to still be running when deploy B
    // is driven below. It is left to exit ON ITS OWN (never killed) — on Windows,
    // forcefully killing only the immediate `deploy` process leaves its own spawned
    // grandchild (the deployed command, launched through cmd.exe by spawnInherit) as an
    // orphan still holding a handle on `root`'s cwd, which then fails this test's own
    // temp-dir cleanup in afterEach. Letting both processes finish naturally avoids that
    // entirely and is a truer rendition of the review's timeline besides (A finishes
    // normally; nothing crashes, no signal, no kill).
    const a = spawn('node', [CLI, 'deploy', '--reason', 'A in progress', '--', NODE, '-e', 'setTimeout(()=>{}, 1500)'], { cwd: root, stdio: 'ignore' });
    const aExit = new Promise((r) => a.on('exit', r));
    try {
      const deployPath = pshed('run', 'DEPLOY');
      const pausedPath = pshed('run', 'PAUSED');
      // Ownership (run/DEPLOY) is written BEFORE the pause (own -> wait -> pause, see
      // CLAUDE.md), so poll for the LATER of the two — otherwise this can race and
      // observe DEPLOY without PAUSED yet.
      const deadline = Date.now() + 8000;
      while (!existsSync(pausedPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(deployPath)).toBe(true); // A has claimed ownership
      expect(existsSync(pausedPath)).toBe(true); // and is holding the scheduler paused
      const ownerBefore = JSON.parse(readFileSync(deployPath, 'utf-8'));

      // Deploy B, run to completion synchronously: it must be refused immediately, not
      // wait, not run its own command.
      const b = cli(['deploy', '--reason', 'B wants in', '--json', '--', NODE, '-e', 'console.log("B-RAN")']);
      expect(b.status).toBe(2);
      expect(b.stdout).not.toContain('B-RAN'); // B's command never ran
      const report = JSON.parse(b.stderr);
      expect(report.outcome).toBe('busy');
      expect(report.holder.pid).toBe(ownerBefore.pid);

      // A's ownership and pause are untouched by B's refusal.
      expect(JSON.parse(readFileSync(deployPath, 'utf-8'))).toMatchObject({ pid: ownerBefore.pid });
      expect(existsSync(pshed('run', 'PAUSED'))).toBe(true);
    } finally {
      await aExit; // let A finish and release the checkout on its own
    }
  }, 20_000);
});

// POSIX only: measured, a spawn error other than ENOENT (e.g. EACCES on a file without
// the execute bit) has no Windows equivalent that arises the same way — on win32 the
// shell (spawnInherit uses shell:true there) reports a missing/unrunnable command as a
// plain exit 1 from cmd.exe itself, never a rejected spawn 'error' event. This is why the
// finding's own reproduction is POSIX-only, and why the existing SIGINT test above uses
// the same skipIf pattern.
describe.skipIf(process.platform === 'win32')('deploy reports an unexpected spawn error on stderr, never stdout', () => {
  it('keeps stdout clean and puts the diagnosis on stderr when the target cannot be spawned (EACCES)', () => {
    writeJobs(TWO_JOBS);
    const scriptPath = join(root, 'not-executable.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho MUST-NOT-RUN\n', 'utf-8');
    chmodSync(scriptPath, 0o644); // no execute bit: spawn rejects with EACCES, not ENOENT

    const r = cli(['deploy', '--reason', 'x', '--json', '--', scriptPath]);

    // The deployed command's channel (stdout) must stay untouched by p-shed's own
    // failure report — that guarantee is the entire point of `deploy`.
    expect(r.stdout).toBe('');
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stderr);
    expect(report.action).toBe('deploy');
    expect(report.outcome).not.toBe('ok');
    expect(JSON.stringify(report)).toMatch(/EACCES/);
    // The pause is still released even though the command never ran.
    expect(existsSync(pshed('run', 'PAUSED'))).toBe(false);
    expect(existsSync(pshed('run', 'DEPLOY'))).toBe(false);
  });

  it('renders the same failure in human format (no --json) without touching stdout', () => {
    writeJobs(TWO_JOBS);
    const scriptPath = join(root, 'not-executable-2.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho MUST-NOT-RUN\n', 'utf-8');
    chmodSync(scriptPath, 0o644);

    const r = cli(['deploy', '--reason', 'x', '--', scriptPath]);

    expect(r.stdout).toBe('');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/EACCES/);
    expect(() => JSON.parse(r.stderr)).toThrow(); // human format, not JSON
  });
});

// Pure string assertions on quoteWinArg's output — no shell involved, so these run and
// mean the same thing on every platform, unlike the e2e round-trip above which only
// exercises the win32 branch when the suite itself runs on win32. These lock in the
// documented CommandLineToArgvW rules (backslash-run special only right before a quote,
// or at the very end of the argument) rather than changing any behavior.
describe('quoteWinArg', () => {
  it('wraps a plain path with backslashes untouched (no quote follows them)', () => {
    expect(quoteWinArg('C:\\Users\\test\\file.txt')).toBe('"C:\\Users\\test\\file.txt"');
  });

  it('doubles a trailing run of backslashes so it does not escape the closing quote', () => {
    expect(quoteWinArg('C:\\path\\')).toBe('"C:\\path\\\\"');
  });

  it('escapes an embedded double quote', () => {
    expect(quoteWinArg('embedded"quote')).toBe('"embedded\\"quote"');
  });

  it('escapes a quote sitting at the very end of the argument', () => {
    expect(quoteWinArg('quote-at-end"')).toBe('"quote-at-end\\""');
  });

  it('wraps an argument containing spaces so it stays one token', () => {
    expect(quoteWinArg('hello world')).toBe('"hello world"');
  });

  it('leaves shell metacharacters & ^ | > < untouched inside the quotes', () => {
    expect(quoteWinArg('a&b^c|d>e<f')).toBe('"a&b^c|d>e<f"');
  });
});

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
