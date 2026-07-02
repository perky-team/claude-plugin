import { openSync, writeSync, closeSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True if the process exists. `process.kill(pid, 0)` sends no signal: it throws
// ESRCH when the process is gone, and EPERM when it exists but we may not signal
// it (still alive). Any other outcome is treated as alive to avoid stealing a
// live holder's lock.
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// A lock is stale if its holder pid is dead, or (when the pid is unknown/partial
// because we caught the holder mid-write) if the file itself is older than
// staleMs. A freshly created lock has a recent mtime, so it is never mistaken for
// stale during the tiny window between create and write.
function isStale(lockPath, staleMs) {
  let raw;
  try { raw = readFileSync(lockPath, 'utf-8'); } catch { return false; }
  let info = null;
  try { info = JSON.parse(raw); } catch { /* partial / empty */ }
  if (info?.pid) return !pidAlive(info.pid);
  if (info?.ts) return Date.now() - info.ts > staleMs;
  try { return Date.now() - statSync(lockPath).mtimeMs > staleMs; } catch { return false; }
}

export async function withReindexLock(pgraphDir, opts, fn) {
  const { timeoutMs = 5000, staleMs = 60000, pollMs = 50 } = opts ?? {};
  const lockPath = join(pgraphDir, 'reindex.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // atomic O_CREAT|O_EXCL
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      try { return { acquired: true, result: await fn() }; }
      finally { try { unlinkSync(lockPath); } catch { /* already gone */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (isStale(lockPath, staleMs)) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
      if (Date.now() >= deadline) return { acquired: false };
      await sleep(pollMs);
    }
  }
}
