import { spawn } from 'node:child_process';

export function buildArgs(job, defaults) {
  const mode = job.permissionMode ?? defaults.permissionMode ?? 'acceptEdits';
  const allowed = job.allowedTools ?? defaults.allowedTools;
  const args = ['-p', job.prompt, '--output-format', 'json', '--permission-mode', mode];
  if (allowed) args.push('--allowedTools', allowed);
  const model = job.model ?? defaults.model;
  if (model) args.push('--model', model);
  // --effort mirrors --model (job overrides defaults). Skip it for Haiku models:
  // the param errors on Haiku 4.5, so a set effort is silently dropped there.
  const effort = job.effort ?? defaults.effort;
  if (effort && !/haiku/i.test(String(model ?? ''))) args.push('--effort', effort);
  return args;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}

export function runJob({ job, defaults, claudeBin, spawnFn = spawn, killFn = killTree, now = Date.now, onSpawn }) {
  return new Promise((resolve) => {
    const start = now();
    const args = buildArgs(job, defaults);
    const timeoutSec = job.timeoutSec ?? defaults.timeoutSec ?? 900;
    const isWin = process.platform === 'win32';
    // On Windows `claude` is a `.cmd` shim; Node's spawn can't launch it directly
    // (and must not use shell:true, which mangles a prompt containing spaces).
    // Route through cmd.exe so Node's normal argv quoting still applies to the prompt.
    const file = isWin ? (process.env.ComSpec || 'cmd.exe') : claudeBin;
    const spawnArgs = isWin ? ['/c', claudeBin, ...args] : args;
    const child = spawnFn(file, spawnArgs, {
      cwd: job.cwd ?? defaults.cwd ?? '.',
      detached: !isWin,          // own process group so killFn(-pid) reaps children on POSIX
      stdio: ['ignore', 'pipe', 'pipe'], // capture output so the run can be classified
      windowsHide: true,
    });
    // Capture stdout/stderr (bounded) so the classifier can tell a usage-limit / API
    // overload from a real failure — Claude Code has no distinct exit code for a limit,
    // only message text. Keep the TAIL: the `--output-format json` result and any limit
    // message land at the end, and an unbounded buffer could exhaust memory on a chatty
    // run. Optional-chained so a stdio-less spawn stub (tests) doesn't throw.
    const CAP = 64 * 1024;
    let out = '', err = '';
    child.stdout?.on('data', (c) => { out = (out + c).slice(-CAP); });
    child.stderr?.on('data', (c) => { err = (err + c).slice(-CAP); });
    child.stdout?.on('error', () => {}); // ignore pipe teardown races when killed
    child.stderr?.on('error', () => {});
    // Publish the pidfile NOW (before awaiting exit) so a concurrent minute-tick sees a
    // live run and skips it. The duplicate guard must hold for the whole run — writing
    // the pidfile only after the run would let overlapping ticks double-launch long jobs.
    if (onSpawn) onSpawn(child.pid);
    let timedOut = false;
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { timedOut = true; killFn(child.pid); }, timeoutSec * 1000);
    child.on('exit', (code) => finish({ pid: child.pid, exit: timedOut ? null : code, timedOut, durationMs: now() - start, out, err }));
    // A spawn failure (bad binary, missing cwd, EACCES) emits 'error'; without this
    // listener Node throws and crashes the whole tick, and the promise would hang
    // because 'exit' may never fire. Resolve with a failure result so the tick logs it
    // and the next tick recovers.
    child.on('error', (e) => finish({ pid: child.pid ?? null, exit: null, timedOut, error: e?.message ?? String(e), durationMs: now() - start, out, err }));
  });
}
