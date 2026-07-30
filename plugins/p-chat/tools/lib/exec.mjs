import { spawn } from 'node:child_process';

// Run a configured scripted command — a shell line from .pchat.json (owner-authored;
// NEVER built from message text). Bounded: timeout -> SIGKILL, output tail-capped.
export function runShell(cmd, { cwd, timeoutSec = 15, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, [], { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const CAP = 64 * 1024;
    let out = '', err = '';
    child.stdout?.on('data', (c) => { out = (out + c).slice(-CAP); });
    child.stderr?.on('data', (c) => { err = (err + c).slice(-CAP); });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutSec * 1000);
    child.on('exit', (code) => finish({ exit: timedOut ? null : code, timedOut, out, err }));
    child.on('error', (e) => finish({ exit: null, timedOut, error: e?.message ?? String(e), out, err }));
  });
}
