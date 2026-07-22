import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { paths } from './io.mjs';

// Per-job duplicate-guard pidfile: run/<id>.pid holds the live child PID for the whole
// run so an overlapping minute-tick sees a live process and skips it. Written at spawn,
// cleared on exit; a dead/stale pid reads as not-running on the next tick.
export function pidPath(root, id) {
  return join(paths(root).runDir, `${id}.pid`);
}

export function writePid(root, id, pid) {
  mkdirSync(paths(root).runDir, { recursive: true });
  writeFileSync(pidPath(root, id), String(pid), 'utf-8');
}

export function removePid(root, id) {
  rmSync(pidPath(root, id), { force: true });
}

export function readPid(root, id) {
  const p = pidPath(root, id);
  if (!existsSync(p)) return null;
  const n = parseInt(readFileSync(p, 'utf-8').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

// signal 0 probes for existence without delivering a signal; EPERM means the process
// exists but is owned by another user (still alive), ESRCH means it is gone.
export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Every <id>.pid file currently on disk, paired with its pid (stale files included).
export function listPidEntries(root) {
  const dir = paths(root).runDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(.+)\.pid$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ id: m[1], pid: readPid(root, m[1]) }))
    .filter((e) => e.pid != null);
}

// Only the jobs whose pidfile points at a live process.
export function listRunningJobs(root, { isAlive = isPidAlive } = {}) {
  return listPidEntries(root).filter((e) => isAlive(e.pid));
}

// Deliver a signal to a job's process. POSIX jobs are spawned detached (own process
// group), so signal the group with a fallback to the bare pid; Windows has no graceful
// signal, so kill the whole tree forcefully with taskkill either way.
export function signalPid(pid, sig) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  try { process.kill(-pid, sig); return true; }
  catch { try { process.kill(pid, sig); return true; } catch { return false; } }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SIGTERM every live pid, wait a grace period, then SIGKILL any survivor. Returns how
// many live jobs were terminated and their ids. Signal/liveness/sleep are injectable so
// the escalation is testable without touching real processes.
export async function terminateJobs(entries, opts = {}) {
  const signal = opts.signal ?? signalPid;
  const isAlive = opts.isAlive ?? isPidAlive;
  const sleep = opts.sleep ?? realSleep;
  const graceMs = opts.graceMs ?? 3000;
  const live = entries.filter((e) => isAlive(e.pid));
  for (const e of live) signal(e.pid, 'SIGTERM');
  if (live.length) await sleep(graceMs);
  for (const e of live) if (isAlive(e.pid)) signal(e.pid, 'SIGKILL');
  return { terminated: live.length, ids: live.map((e) => e.id) };
}
