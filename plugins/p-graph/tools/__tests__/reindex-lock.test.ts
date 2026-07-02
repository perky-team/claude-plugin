import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withReindexLock, pidAlive } from '../lib/index/lock.mjs';

let pg;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-'));
  pg = join(dir, '.pgraph');
  mkdirSync(pg);
});
afterEach(() => rmSync(join(pg, '..'), { recursive: true, force: true }));

describe('pidAlive', () => {
  it('is true for the current process and false for an unused pid', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2147483646)).toBe(false); // effectively never a live pid
  });
});

describe('withReindexLock', () => {
  it('acquires, runs fn, and releases the lock', async () => {
    const lockPath = join(pg, 'reindex.lock');
    const r = await withReindexLock(pg, {}, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(r).toEqual({ acquired: true, result: 42 });
    expect(existsSync(lockPath)).toBe(false); // released
  });

  it('does not steal a lock held by a live process (times out)', async () => {
    const lockPath = join(pg, 'reindex.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    let ran = false;
    const r = await withReindexLock(pg, { timeoutMs: 150, pollMs: 20 }, async () => { ran = true; });
    expect(r.acquired).toBe(false);
    expect(ran).toBe(false);
  });

  it('steals a stale lock (dead pid) and runs fn', async () => {
    const lockPath = join(pg, 'reindex.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, ts: Date.now() }));
    const r = await withReindexLock(pg, { timeoutMs: 500, pollMs: 20 }, async () => 'ok');
    expect(r).toEqual({ acquired: true, result: 'ok' });
  });

  it('steals a lock whose timestamp is older than staleMs', async () => {
    const lockPath = join(pg, 'reindex.lock');
    // No pid field, old timestamp -> stale by age.
    writeFileSync(lockPath, JSON.stringify({ ts: Date.now() - 999999 }));
    const r = await withReindexLock(pg, { timeoutMs: 500, pollMs: 20, staleMs: 1000 }, async () => 'ok');
    expect(r.acquired).toBe(true);
  });
});
