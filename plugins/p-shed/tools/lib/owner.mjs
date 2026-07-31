import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './io.mjs';
import { isPidAlive } from './pids.mjs';
import { listPauseIds, readPauseRecord, removePause } from './breaker.mjs';
import { readGlobalPause, removeGlobalPause } from './pause.mjs';

// Who is currently holding a deploy pause. A signal trap cannot be the recovery
// mechanism — measured, a Node process on Windows receives neither SIGTERM nor SIGINT,
// and SIGKILL / a reboot / a power cut defeat a trap on every platform. So the owner is
// recorded on disk and the tick reclaims what a dead owner abandoned.
//
// This file is `DEPLOY`, not `<something>.pid`: the only reader of run/ is
// listPidEntries(), whose regex is /^(.+)\.pid$/, so this can never become a phantom job
// in `status` or in `stop --kill`'s teardown — the trap CLAUDE.md records against a
// run/<group>.pid file.
export function deployOwnerPath(root) {
  return join(paths(root).runDir, 'DEPLOY');
}

export function readDeployOwner(root) {
  const p = deployOwnerPath(root);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, 'utf-8'));
    return typeof o?.pid === 'number' ? o : null;
  } catch {
    return null; // corrupt (e.g. killed mid-write) -> no owner, so its pauses are orphans
  }
}

// Written BEFORE any pause is placed, so the "marker exists, owner unknown" window
// cannot open. The reverse window (owner recorded, nothing paused yet) is harmless:
// there is nothing to reclaim.
//
// Atomic: write to a temp file in the SAME directory, then renameSync over the real
// path. A plain writeFileSync can be read mid-write by a concurrent readDeployOwner
// (another `deploy` process, or the tick), which sees a truncated/partial JSON blob,
// fails to parse it, and reads back as "no owner" — a live deploy's pause then looks
// like an orphan and gets reclaimed out from under it. rename() on the same filesystem
// is atomic on both POSIX and Windows: readers only ever see the old complete content
// or the new complete content, never a half-written one.
export function writeDeployOwner(root, { pid, scope, group = null, reason = null, now = Date.now() } = {}) {
  const state = { pid, scope, group, reason, createdAt: now };
  const dir = paths(root).runDir;
  mkdirSync(dir, { recursive: true });
  const target = deployOwnerPath(root);
  const tmp = join(dir, `.DEPLOY.${process.pid}.${now}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return state;
}

export function removeDeployOwner(root) {
  rmSync(deployOwnerPath(root), { force: true });
}

// A deploy-origin marker is an orphan when run/DEPLOY is absent or its pid is not alive.
// ONLY deploy-origin markers are touched: an operator pause is a halt a human set on
// purpose, and lifting it here would silence the loop exactly the way trap 1 did.
export function reclaimOrphanedDeployPauses(root, { isAlive = isPidAlive } = {}) {
  const owner = readDeployOwner(root);
  if (owner && isAlive(owner.pid)) return { reclaimed: [] };

  const reclaimed = [];
  if (readGlobalPause(root)?.origin === 'deploy') {
    removeGlobalPause(root);
    reclaimed.push({ scope: 'global' });
  }
  for (const id of listPauseIds(root)) {
    if (readPauseRecord(root, id)?.origin !== 'deploy') continue;
    removePause(root, id);
    reclaimed.push({ scope: 'job', id });
  }
  if (owner) removeDeployOwner(root);
  return { reclaimed };
}
