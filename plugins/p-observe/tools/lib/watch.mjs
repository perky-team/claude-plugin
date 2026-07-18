import { readFileSync, watch as fsWatch, existsSync } from 'node:fs';

export function safeRead(path, parse) {
  try {
    const value = parse(readFileSync(path, 'utf-8'));
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

// Watches a directory, coalescing bursts into one debounced onChange().
// fs.watch event details are treated as a hint only — the caller re-reads state.
// Falls back to a polling interval (which still fires the debounced onChange) when
// the target is missing at start time or fs.watch throws (unsupported platform) —
// adapters re-read+diff on every fire, so an extra poll fire with no real change is
// a safe no-op, and a target created later (e.g. `.pshed/run` on first job launch)
// is still picked up.
export function watchPath(target, onChange, { debounceMs = 150, pollMs = 1500 } = {}) {
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
  };
  let watcher = null;
  let poll = null;
  try { if (existsSync(target)) watcher = fsWatch(target, { recursive: false }, fire); }
  catch { watcher = null; } // platform without watch support -> poll
  if (!watcher) poll = setInterval(fire, pollMs); // missing target or unsupported fs.watch -> poll
  return {
    close() { clearTimeout(timer); if (watcher) watcher.close(); if (poll) clearInterval(poll); },
  };
}
