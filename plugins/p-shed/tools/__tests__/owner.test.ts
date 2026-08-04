// run/DEPLOY records which process is holding a deploy pause, so a pause abandoned by a
// SIGKILLed / rebooted deploy is reclaimed by the next tick instead of silencing the
// loop forever. On Windows this is the ONLY recovery path: measured, a Node process
// there receives neither SIGTERM nor SIGINT, so a signal trap cannot be the mechanism.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deployOwnerPath, readDeployOwner, writeDeployOwner, removeDeployOwner,
  reclaimOrphanedDeployPauses,
} from '../lib/owner.mjs';
import { writePause, readPauseRecord, pausePath, listPauseIds } from '../lib/breaker.mjs';
import { writeGlobalPause, readGlobalPause, globalPausePath } from '../lib/pause.mjs';
import { paths } from '../lib/io.mjs';

// writeFileSync/renameSync are wrapped (not replaced — every other call in this file still
// delegates to the real implementation) so the two tests below can inspect the actual
// sequence of fs calls writeDeployOwner makes, instead of only inferring it from the end
// state on disk.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-owner-')); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks(); // call history must not leak between tests
});

const dead = () => false;
const alive = () => true;

describe('run/DEPLOY', () => {
  it('is at run/DEPLOY and round-trips', () => {
    expect(deployOwnerPath(root)).toBe(join(root, '.pshed', 'run', 'DEPLOY'));
    writeDeployOwner(root, { pid: 4242, scope: 'global', reason: 'prompt update', now: 111 });
    expect(readDeployOwner(root)).toEqual({ pid: 4242, scope: 'global', group: null, reason: 'prompt update', createdAt: 111 });
  });

  it('reads as absent when missing or corrupt', () => {
    expect(readDeployOwner(root)).toBeNull();
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(deployOwnerPath(root), '{not json', 'utf-8');
    expect(readDeployOwner(root)).toBeNull();
  });

  it('removeDeployOwner is idempotent', () => {
    writeDeployOwner(root, { pid: 1, scope: 'global', now: 1 });
    removeDeployOwner(root);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
    expect(() => removeDeployOwner(root)).not.toThrow();
  });

  it('is not a job pidfile — listPidEntries must not see it', async () => {
    const { listPidEntries } = await import('../lib/pids.mjs');
    writeDeployOwner(root, { pid: 1, scope: 'global', now: 1 });
    expect(listPidEntries(root)).toEqual([]);
  });

  // C1: writeDeployOwner used to be a plain writeFileSync, so a concurrent readDeployOwner
  // (another `deploy`, or the tick) could observe a torn/partial write mid-JSON and fail to
  // parse it — reading back as "no owner", which makes a LIVE deploy's pause look like an
  // orphan. The fix writes to a temp file in the same directory and renameSync's it over
  // the real path; renameSync is atomic, so no reader ever sees a partial write.
  //
  // A prior version of this test only asserted "no leftover temp file after the call" —
  // but a plain writeFileSync straight to the target ALSO leaves no temp litter, so that
  // assertion passes against the unfixed code too and pins nothing about atomicity. These
  // two tests replace it: the first inspects the actual sequence of fs calls to confirm
  // the write genuinely goes through a distinct temp file + rename (not a direct write),
  // and the second pins the cleanup that path requires when the rename step itself fails.
  it('writes via a temp file distinct from the target, then renames it over the target', () => {
    writeDeployOwner(root, { pid: 4242, scope: 'global', reason: 'x', now: 1 });
    const target = deployOwnerPath(root);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const renameCalls = vi.mocked(renameSync).mock.calls;
    expect(writeCalls.length).toBe(1);
    expect(renameCalls.length).toBe(1);

    const [writtenPath] = writeCalls[0];
    const [renameFrom, renameTo] = renameCalls[0];
    expect(writtenPath).not.toBe(target); // never written directly to the real path
    expect(String(writtenPath)).toMatch(/\.DEPLOY\.\d+\.\d+\.tmp$/);
    expect(renameFrom).toBe(writtenPath); // the SAME temp file is what gets renamed
    expect(renameTo).toBe(target);

    // End state is unchanged from before: only the real file remains on disk.
    expect(readdirSync(paths(root).runDir)).toEqual(['DEPLOY']);
    expect(readDeployOwner(root)).toMatchObject({ pid: 4242, reason: 'x' });
  });

  it('cleans up the temp file when the rename step itself throws (EPERM/EBUSY are real on Windows)', () => {
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('boom'), { code: 'EPERM' });
    });
    expect(() => writeDeployOwner(root, { pid: 4242, scope: 'global', reason: 'x', now: 1 })).toThrow('boom');
    // No DEPLOY file (the rename never completed) AND no leftover .tmp file either — a
    // failed rename must not litter run/ forever.
    expect(existsSync(deployOwnerPath(root))).toBe(false);
    expect(readdirSync(paths(root).runDir)).toEqual([]);
  });
});

describe('listPauseIds', () => {
  it('lists every <id>.pause and ignores other run files', () => {
    writePause(root, 'a', { reason: 'x', origin: 'operator' });
    writePause(root, 'b', { reason: 'y', origin: 'deploy' });
    writeGlobalPause(root, { reason: 'z' });
    writeDeployOwner(root, { pid: 1, scope: 'global', now: 1 });
    expect(listPauseIds(root).sort()).toEqual(['a', 'b']);
  });
  it('returns [] when the run dir does not exist', () => {
    expect(listPauseIds(root)).toEqual([]);
  });
});

describe('reclaimOrphanedDeployPauses', () => {
  it('lifts a global deploy pause whose owner is dead', () => {
    writeDeployOwner(root, { pid: 999001, scope: 'global', reason: 'prompt update', now: 1 });
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed).toEqual([{ scope: 'global' }]);
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('lifts per-job deploy pauses whose owner is dead', () => {
    writeDeployOwner(root, { pid: 999001, scope: 'group', group: 'hft', now: 1 });
    writePause(root, 'worker', { reason: 'prompt update', origin: 'deploy' });
    writePause(root, 'chat', { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed.sort((a, b) => String((a as any).id).localeCompare(String((b as any).id))))
      .toEqual([{ scope: 'job', id: 'chat' }, { scope: 'job', id: 'worker' }]);
    expect(existsSync(pausePath(root, 'worker'))).toBe(false);
    expect(existsSync(pausePath(root, 'chat'))).toBe(false);
  });

  it('leaves everything alone while the owner is alive', () => {
    writeDeployOwner(root, { pid: process.pid, scope: 'global', now: 1 });
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    writePause(root, 'worker', { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: alive });
    expect(res.reclaimed).toEqual([]);
    expect(readGlobalPause(root)).not.toBeNull();
    expect(existsSync(pausePath(root, 'worker'))).toBe(true);
  });

  it('NEVER lifts an operator pause, even with a dead owner recorded', () => {
    writeDeployOwner(root, { pid: 999001, scope: 'global', now: 1 });
    writeGlobalPause(root, { reason: 'halted by hand' });          // no origin -> operator
    writePause(root, 'worker', { reason: 'by hand', origin: 'operator' });
    writePause(root, 'selfy', { reason: 'verify went red', origin: 'self' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed).toEqual([]);
    expect(readGlobalPause(root)).not.toBeNull();
    expect(readPauseRecord(root, 'worker')).toEqual({ origin: 'operator', reason: 'by hand' });
    expect(readPauseRecord(root, 'selfy')).toEqual({ origin: 'self', reason: 'verify went red' });
  });

  it('treats a deploy pause with no run/DEPLOY at all as an orphan', () => {
    writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy' });
    writePause(root, 'worker', { reason: 'prompt update', origin: 'deploy' });
    const res = reclaimOrphanedDeployPauses(root, { isAlive: alive });
    expect(res.reclaimed.length).toBe(2);
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(pausePath(root, 'worker'))).toBe(false);
  });

  it('is a no-op with nothing paused and no owner', () => {
    expect(reclaimOrphanedDeployPauses(root, { isAlive: dead })).toEqual({ reclaimed: [] });
  });

  // M4: readDeployOwner returns null for a CORRUPT run/DEPLOY (see 'reads as absent when
  // missing or corrupt' above), so the old `if (owner) removeDeployOwner(root)` at the end
  // never ran for this case — the corrupt file sat there forever and every later tick
  // re-did this same scan for nothing. Sweeping it unconditionally fixes that without
  // depending on `owner` having parsed.
  it('sweeps a corrupt run/DEPLOY even though it never parsed into an owner', () => {
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(deployOwnerPath(root), '{not json', 'utf-8');
    expect(readDeployOwner(root)).toBeNull(); // confirms the corrupt-file precondition
    const res = reclaimOrphanedDeployPauses(root, { isAlive: dead });
    expect(res.reclaimed).toEqual([]); // nothing paused, so nothing to reclaim
    expect(existsSync(deployOwnerPath(root))).toBe(false); // but the stale file is gone
  });
});
