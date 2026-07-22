import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidPath, writePid, readPid, removePid, isPidAlive, listPidEntries, listRunningJobs, terminateJobs } from '../lib/pids.mjs';
import { paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-pids-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('pid files', () => {
  it('pidPath is run/<id>.pid under root', () => {
    expect(pidPath(root, 'a')).toBe(join(root, '.pshed', 'run', 'a.pid'));
  });
  it('writePid then readPid round-trips the pid', () => {
    writePid(root, 'a', 4242);
    expect(readPid(root, 'a')).toBe(4242);
  });
  it('readPid returns null when the file is absent or non-numeric', () => {
    expect(readPid(root, 'missing')).toBeNull();
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pidPath(root, 'junk'), 'not-a-pid', 'utf-8');
    expect(readPid(root, 'junk')).toBeNull();
  });
  it('removePid deletes the file (idempotent)', () => {
    writePid(root, 'a', 1);
    removePid(root, 'a');
    expect(readPid(root, 'a')).toBeNull();
    expect(() => removePid(root, 'a')).not.toThrow();
  });
});

describe('isPidAlive', () => {
  it('reports the current process alive and falsy pids dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(null)).toBe(false);
  });
});

describe('listPidEntries / listRunningJobs', () => {
  it('lists every <id>.pid file, ignoring other files', () => {
    writePid(root, 'a', 111);
    writePid(root, 'b', 222);
    writeFileSync(join(paths(root).runDir, 'PAUSED'), '{}', 'utf-8');
    writeFileSync(join(paths(root).runDir, 'c.pause'), 'x', 'utf-8');
    const entries = listPidEntries(root).sort((x, y) => x.id.localeCompare(y.id));
    expect(entries).toEqual([{ id: 'a', pid: 111 }, { id: 'b', pid: 222 }]);
  });
  it('returns [] when the run dir does not exist', () => {
    expect(listPidEntries(root)).toEqual([]);
  });
  it('listRunningJobs keeps only entries whose pid is live', () => {
    writePid(root, 'alive', 111);
    writePid(root, 'dead', 222);
    const isAlive = (pid: number) => pid === 111;
    expect(listRunningJobs(root, { isAlive })).toEqual([{ id: 'alive', pid: 111 }]);
  });
});

describe('terminateJobs', () => {
  it('SIGTERMs live pids and does not escalate when they die on SIGTERM', async () => {
    let alive = true;
    const signal = vi.fn((_pid: number, sig: string) => { if (sig === 'SIGTERM') alive = false; return true; });
    const isAlive = () => alive;
    const res = await terminateJobs([{ id: 'a', pid: 999001 }], { signal, isAlive, sleep: async () => {}, graceMs: 0 });
    expect(signal).toHaveBeenCalledWith(999001, 'SIGTERM');
    expect(signal).not.toHaveBeenCalledWith(999001, 'SIGKILL');
    expect(res).toEqual({ terminated: 1, ids: ['a'] });
  });

  it('escalates to SIGKILL for a pid that survives the grace period', async () => {
    const signal = vi.fn(() => true);
    const isAlive = () => true; // never dies on SIGTERM
    const res = await terminateJobs([{ id: 'a', pid: 999002 }], { signal, isAlive, sleep: async () => {}, graceMs: 0 });
    expect(signal).toHaveBeenCalledWith(999002, 'SIGTERM');
    expect(signal).toHaveBeenCalledWith(999002, 'SIGKILL');
    expect(res).toEqual({ terminated: 1, ids: ['a'] });
  });

  it('ignores pids that are already dead (nothing signaled)', async () => {
    const signal = vi.fn(() => true);
    const isAlive = () => false;
    const res = await terminateJobs([{ id: 'a', pid: 999003 }], { signal, isAlive, sleep: async () => {}, graceMs: 0 });
    expect(signal).not.toHaveBeenCalled();
    expect(res).toEqual({ terminated: 0, ids: [] });
  });
});
