import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalPausePath, readGlobalPause, writeGlobalPause, removeGlobalPause } from '../lib/pause.mjs';
import {
  pausePath, readPause, readPauseRecord, writePause, resetBreaker,
  OPERATOR_ORIGIN_LINE, DEPLOY_ORIGIN_LINE,
} from '../lib/breaker.mjs';
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

  // I1: an operator pausing landing on a deploy's own marker must take OWNERSHIP of it —
  // not just report it — so that when the deploy later releases (which only clears a
  // marker still carrying ITS OWN origin), the human's halt survives. Before this fix,
  // `writeGlobalPause` treated every "already paused" call the same way (report and keep
  // the FIRST reason), which is right for two operator pauses but wrong here: it left the
  // marker's origin as 'deploy', so the deploy's own release deleted it regardless of the
  // operator's intervening `pause`.
  describe('operator pause takes ownership of a deploy pause (I1)', () => {
    it('flips origin to operator and replaces the reason when one is given', () => {
      writeGlobalPause(root, { reason: 'deploying prompt update', origin: 'deploy', now: 1 });
      // Mirrors the CLI's own call shape for a plain `pshed pause --reason ...`: no
      // explicit origin (see pshed.mjs's pause command).
      const res = writeGlobalPause(root, { reason: 'incident: stop everything', now: 2 });
      expect(res).toMatchObject({ paused: true, alreadyPaused: true, tookOwnership: true, origin: 'operator', reason: 'incident: stop everything' });
      const stored = readGlobalPause(root);
      expect(stored).toMatchObject({ origin: 'operator', reason: 'incident: stop everything' });
      expect(stored.createdAt).toBe(1); // createdAt is preserved, only origin/reason change
    });

    it('keeps the deploy reason when the operator gives none, but still flips the origin', () => {
      writeGlobalPause(root, { reason: 'deploying prompt update', origin: 'deploy', now: 1 });
      const res = writeGlobalPause(root, {});
      expect(res).toMatchObject({ tookOwnership: true, origin: 'operator', reason: 'deploying prompt update' });
    });

    it('does NOT take ownership when the existing marker is already operator-origin — first reason wins', () => {
      writeGlobalPause(root, { reason: 'first reason', origin: 'operator', now: 1 });
      const res = writeGlobalPause(root, { reason: 'second reason' });
      expect(res.tookOwnership).toBeUndefined();
      expect(res).toMatchObject({ alreadyPaused: true, reason: 'first reason' });
      expect(readGlobalPause(root).reason).toBe('first reason');
    });

    it('surfaces origin on a plain already-paused response too (I1 fix #3)', () => {
      writeGlobalPause(root, { reason: 'halted by hand', now: 1 }); // no origin -> operator
      const res = writeGlobalPause(root, { reason: 'again' });
      expect(res.origin).toBeUndefined(); // this marker never had an origin field
      expect(res.alreadyPaused).toBe(true);
    });
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

  // M3: OPERATOR_ORIGIN_LINE / DEPLOY_ORIGIN_LINE had zero call sites — writePause built
  // the header from a template literal instead. Now that it uses the constants, this
  // pins the header text to THEM rather than to a second, independently-typed literal.
  it('writes the header from the exported origin-line constants, not a re-templated literal', () => {
    writePause(root, 'op', { reason: 'by hand', origin: 'operator' });
    expect(readFileSync(pausePath(root, 'op'), 'utf-8')).toBe(`${OPERATOR_ORIGIN_LINE}\nby hand\n`);
    writePause(root, 'dep', { reason: 'prompt update', origin: 'deploy' });
    expect(readFileSync(pausePath(root, 'dep'), 'utf-8')).toBe(`${DEPLOY_ORIGIN_LINE}\nprompt update\n`);
  });

  // I1 (group/job scope — "Group scope has the same hole via run/<id>.pause"): the same
  // ownership-takeover rule as the global marker above, so `pause --id/--group` landing on
  // a deploy pause survives that deploy's own release.
  describe('operator pause takes ownership of a job-level deploy pause (I1)', () => {
    it('flips origin to operator and replaces the reason when one is given', () => {
      writePause(root, 'w', { reason: 'deploying prompt update', origin: 'deploy' });
      const res = writePause(root, 'w', { reason: 'incident: stop everything', origin: 'operator' });
      expect(res).toMatchObject({ paused: true, alreadyPaused: true, tookOwnership: true, origin: 'operator', reason: 'incident: stop everything' });
      expect(readPauseRecord(root, 'w')).toEqual({ origin: 'operator', reason: 'incident: stop everything' });
      expect(readFileSync(pausePath(root, 'w'), 'utf-8')).toBe(`${OPERATOR_ORIGIN_LINE}\nincident: stop everything\n`);
    });

    it('keeps the deploy reason when the operator gives none, but still flips the origin', () => {
      writePause(root, 'w', { reason: 'deploying prompt update', origin: 'deploy' });
      const res = writePause(root, 'w', { origin: 'operator' });
      expect(res).toMatchObject({ tookOwnership: true, origin: 'operator', reason: 'deploying prompt update' });
    });

    it('does NOT take ownership of an already-operator or self marker — first reason wins, unchanged', () => {
      writePause(root, 'oper', { reason: 'first reason', origin: 'operator' });
      const res1 = writePause(root, 'oper', { reason: 'second reason', origin: 'operator' });
      expect(res1.tookOwnership).toBeUndefined();
      expect(res1.reason).toBe('first reason');

      writePause(root, 'selfy', { reason: 'verify went red', origin: 'self' });
      const res2 = writePause(root, 'selfy', { reason: 'operator reason', origin: 'operator' });
      expect(res2.tookOwnership).toBeUndefined();
      expect(res2).toMatchObject({ origin: 'self', reason: 'verify went red' });
    });
  });
});
