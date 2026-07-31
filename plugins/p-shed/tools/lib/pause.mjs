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

export function writeGlobalPause(root, { reason, origin, now = Date.now() } = {}) {
  const existing = readGlobalPause(root);
  if (existing) {
    // An operator pause landing on a deploy-origin marker takes OWNERSHIP of it: origin
    // flips away from 'deploy' (to this caller's own, 'operator' unless stated
    // otherwise) and the reason is replaced when one was given — so the human's halt
    // survives the deploy's own release, which only clears a marker still carrying ITS
    // origin (see dropOwnPauses in lib/deploy.mjs). A marker already 'operator' (or any
    // non-deploy origin) is unchanged here: pausing an already-paused job keeps the
    // FIRST reason, which is what explains why it actually stopped.
    if (existing.origin === 'deploy' && origin !== 'deploy') {
      const claimedOrigin = origin ?? 'operator';
      const state = { createdAt: existing.createdAt ?? now, origin: claimedOrigin };
      if (reason != null) state.reason = reason;
      else if (existing.reason != null) state.reason = existing.reason;
      const dir = paths(root).runDir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(globalPausePath(root), JSON.stringify(state, null, 2) + '\n', 'utf-8');
      return { paused: true, alreadyPaused: true, tookOwnership: true, createdAt: state.createdAt, reason: state.reason, origin: state.origin };
    }
    // Surfaces the existing marker's origin (not just its reason) so an operator can see
    // WHAT they walked into — a deploy pause and a forgotten operator pause used to look
    // identical in this response.
    return { paused: true, alreadyPaused: true, createdAt: existing.createdAt ?? null, reason: existing.reason, origin: existing.origin };
  }
  const state = { createdAt: now };
  if (reason != null) state.reason = reason;
  if (origin != null) state.origin = origin;
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
