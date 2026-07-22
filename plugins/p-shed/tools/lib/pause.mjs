import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './io.mjs';

// Global scheduler pause marker: `run/PAUSED`. Unlike the per-job `run/<id>.pause`
// (written by a job's own run to stop being scheduled), this halts *every* job while
// cron stays installed — the reversible "stop to reconfigure, then resume" lever. It
// lives under run/ (like the per-job marker) and clearing it is a plain file delete, so
// it is independent of the cwd-scoped cron task id.
export function globalPausePath(root) {
  return join(paths(root).runDir, 'PAUSED');
}

export function readGlobalPause(root) {
  const p = globalPausePath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch { return {}; } // present but unreadable -> still paused (truthy)
}

export function writeGlobalPause(root, { reason, now = Date.now() } = {}) {
  const existing = readGlobalPause(root);
  if (existing) return { paused: true, alreadyPaused: true, createdAt: existing.createdAt ?? null, reason: existing.reason };
  const state = { createdAt: now };
  if (reason != null) state.reason = reason;
  const dir = paths(root).runDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(globalPausePath(root), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  return { paused: true, alreadyPaused: false, ...state };
}

export function removeGlobalPause(root) {
  const wasPaused = existsSync(globalPausePath(root));
  rmSync(globalPausePath(root), { force: true });
  return { paused: false, wasPaused };
}
