import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalPausePath, readGlobalPause, writeGlobalPause, removeGlobalPause } from '../lib/pause.mjs';
import { pausePath, readPause, readPauseRecord, writePause, resetBreaker } from '../lib/breaker.mjs';
import { paths } from '../lib/io.mjs';

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

describe('deploy origin', () => {
  it('writePause with origin deploy writes the deploy header and a plain reason', () => {
    writePause(root, 'w', { reason: 'prompt update', origin: 'deploy' });
    expect(readFileSync(pausePath(root, 'w'), 'utf-8')).toBe('#pshed origin=deploy\nprompt update\n');
    expect(readPauseRecord(root, 'w')).toEqual({ origin: 'deploy', reason: 'prompt update' });
  });

  it('readPause returns only the human reason, never the header', () => {
    writePause(root, 'w', { reason: 'prompt update', origin: 'deploy' });
    expect(readPause(root, 'w')).toBe('prompt update');
  });

  it('reset-breaker keeps a deploy pause and says who holds it', () => {
    writePause(root, 'w', { reason: 'prompt update', origin: 'deploy' });
    const res = resetBreaker(root, 'w');
    expect(res.pauseCleared).toBe(false);
    expect(res.deployPause).toBe(true);
    expect(existsSync(pausePath(root, 'w'))).toBe(true);
  });

  it('reset-breaker still clears a self pause and still keeps an operator pause', () => {
    writePause(root, 'selfy', { reason: 'verify went red', origin: 'self' });
    writePause(root, 'oper', { reason: 'by hand', origin: 'operator' });
    expect(resetBreaker(root, 'selfy').pauseCleared).toBe(true);
    expect(existsSync(pausePath(root, 'selfy'))).toBe(false);
    const oper = resetBreaker(root, 'oper');
    expect(oper.operatorPause).toBe(true);
    expect(existsSync(pausePath(root, 'oper'))).toBe(true);
  });

  it('an unrecognised header origin still reads as operator (safe direction)', () => {
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'w'), '#pshed origin=martian\nfrom mars\n', 'utf-8');
    expect(readPauseRecord(root, 'w')).toEqual({ origin: 'operator', reason: 'from mars' });
  });

  it('an empty marker still pauses (presence, not contents)', () => {
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'w'), '', 'utf-8');
    expect(readPause(root, 'w')).toBe('');
    expect(readPauseRecord(root, 'w')).toEqual({ origin: 'self', reason: '' });
  });
});
