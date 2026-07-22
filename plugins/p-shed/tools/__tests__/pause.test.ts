import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalPausePath, readGlobalPause, writeGlobalPause, removeGlobalPause } from '../lib/pause.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-pause-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('global pause', () => {
  it('globalPausePath is run/PAUSED under root', () => {
    expect(globalPausePath(root)).toBe(join(root, '.pshed', 'run', 'PAUSED'));
  });

  it('readGlobalPause returns null when absent', () => {
    expect(readGlobalPause(root)).toBeNull();
  });

  it('writeGlobalPause creates the marker with createdAt and an optional reason', () => {
    const res = writeGlobalPause(root, { reason: 'reconfiguring', now: 1000 });
    expect(res).toMatchObject({ paused: true, alreadyPaused: false, createdAt: 1000, reason: 'reconfiguring' });
    expect(existsSync(globalPausePath(root))).toBe(true);
    expect(readGlobalPause(root)).toMatchObject({ createdAt: 1000, reason: 'reconfiguring' });
  });

  it('writeGlobalPause is idempotent — a second call preserves the original createdAt', () => {
    writeGlobalPause(root, { now: 1000 });
    const again = writeGlobalPause(root, { now: 9999, reason: 'later' });
    expect(again).toMatchObject({ paused: true, alreadyPaused: true, createdAt: 1000 });
    expect(readGlobalPause(root).createdAt).toBe(1000);
  });

  it('removeGlobalPause deletes the marker and reports whether it existed', () => {
    writeGlobalPause(root, { now: 1000 });
    expect(removeGlobalPause(root)).toMatchObject({ paused: false, wasPaused: true });
    expect(existsSync(globalPausePath(root))).toBe(false);
    expect(removeGlobalPause(root)).toMatchObject({ paused: false, wasPaused: false });
  });

  it('a present-but-corrupt marker still reads as paused (truthy)', () => {
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(globalPausePath(root), '{ not json', 'utf-8');
    expect(readGlobalPause(root)).not.toBeNull();
  });
});
