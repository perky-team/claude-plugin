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
export function watchPath(target, onChange, { debounceMs = 150 } = {}) {
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
  };
  let watcher = null;
  if (existsSync(target)) {
    try { watcher = fsWatch(target, { recursive: false }, fire); }
    catch { watcher = null; } // platform without watch support -> caller may poll
  }
  return {
    close() { clearTimeout(timer); if (watcher) watcher.close(); },
  };
}
