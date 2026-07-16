import { spawn } from 'node:child_process';

export function buildArgs(job, defaults) {
  const mode = job.permissionMode ?? defaults.permissionMode ?? 'acceptEdits';
  const allowed = job.allowedTools ?? defaults.allowedTools;
  const args = ['-p', job.prompt, '--output-format', 'json', '--permission-mode', mode];
  if (allowed) args.push('--allowedTools', allowed);
  return args;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
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
      stdio: 'ignore',
      windowsHide: true,
    });
    // Publish the pidfile NOW (before awaiting exit) so a concurrent minute-tick sees a
    // live run and skips it. The duplicate guard must hold for the whole run — writing
    // the pidfile only after the run would let overlapping ticks double-launch long jobs.
    if (onSpawn) onSpawn(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killFn(child.pid); }, timeoutSec * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, exit: timedOut ? null : code, timedOut, durationMs: now() - start });
    });
  });
}
