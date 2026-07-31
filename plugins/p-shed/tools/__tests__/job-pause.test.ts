// The per-job pause marker gained an ORIGIN (job self-pause vs operator) so that
// `reset-breaker` can un-stick a job that stopped itself without silently lifting a
// pause a human put there deliberately. Two hard constraints are asserted here:
// a bare `touch` must keep pausing, and a prompt-written one-line reason must keep
// reading as a self-pause whose text is what `status` shows.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pausePath, readPause, readPauseRecord, writePause, resetBreaker } from '../lib/breaker.mjs';
import { paths, writeJobState, readState } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-jobpause-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Exactly how a job's prompt writes it: a plain shell redirect of one line.
function selfPauseFile(id: string, body: string) {
  mkdirSync(paths(root).runDir, { recursive: true });
  writeFileSync(pausePath(root, id), body, 'utf-8');
}

describe('marker origin', () => {
  it('a plain one-line marker reads as a self-pause whose reason is that line', () => {
    selfPauseFile('a', 'verify went red');
    expect(readPauseRecord(root, 'a')).toMatchObject({ origin: 'self', reason: 'verify went red' });
    expect(readPause(root, 'a')).toBe('verify went red');
  });

  it('an empty marker (a bare touch) still pauses and reads as a self-pause', () => {
    selfPauseFile('a', '');
    expect(readPause(root, 'a')).not.toBeNull(); // presence pauses; contents are not truthiness
    expect(readPauseRecord(root, 'a')).toMatchObject({ origin: 'self', reason: '' });
  });

  it('an absent marker is null for both readers', () => {
    expect(readPause(root, 'a')).toBeNull();
    expect(readPauseRecord(root, 'a')).toBeNull();
  });

  it('an operator pause records its origin but keeps the reason human-readable', () => {
    const res = writePause(root, 'a', { reason: 'deploying new config', origin: 'operator' });
    expect(res).toMatchObject({ id: 'a', paused: true, alreadyPaused: false, origin: 'operator' });
    expect(readPauseRecord(root, 'a')).toMatchObject({ origin: 'operator', reason: 'deploying new config' });
    // The one place a human looks must not turn into a JSON blob.
    expect(readPause(root, 'a')).toBe('deploying new config');
    expect(readFileSync(pausePath(root, 'a'), 'utf-8')).not.toContain('{');
  });

  it('an operator pause with no reason still explains itself', () => {
    writePause(root, 'a', { origin: 'operator' });
    expect(readPause(root, 'a')).toMatch(/operator/i);
    expect(readPauseRecord(root, 'a')!.origin).toBe('operator');
  });

  it('writePause is a no-op on an already-paused job and keeps the FIRST reason', () => {
    selfPauseFile('a', 'verify went red');
    const res = writePause(root, 'a', { reason: 'operator says stop', origin: 'operator' });
    expect(res).toMatchObject({ id: 'a', paused: true, alreadyPaused: true });
    // The first reason is the one that explains why the job stopped.
    expect(readPause(root, 'a')).toBe('verify went red');
    expect(readPauseRecord(root, 'a')!.origin).toBe('self');
  });
});

describe('resetBreaker vs marker origin', () => {
  it('clears a self-pause (its whole point) and reports it', () => {
    writeJobState(root, 'a', { lastRun: 1, consecutiveFailures: 3, breakerTripped: true, breakerReason: 'exit 1' });
    selfPauseFile('a', 'verify went red');

    const res = resetBreaker(root, 'a');

    expect(res).toMatchObject({ id: 'a', cleared: true, pauseCleared: true });
    expect(res.operatorPause).toBeFalsy();
    expect(existsSync(pausePath(root, 'a'))).toBe(false);
    expect(readState(root).jobs.a.consecutiveFailures).toBe(0);
  });

  it('leaves an operator pause in place, says so, and still clears the breaker', () => {
    writeJobState(root, 'a', { lastRun: 1, consecutiveFailures: 3, breakerTripped: true, breakerReason: 'exit 1' });
    writePause(root, 'a', { reason: 'deploying new config', origin: 'operator' });

    const res = resetBreaker(root, 'a');

    expect(res).toMatchObject({ id: 'a', cleared: true, pauseCleared: false, operatorPause: true });
    expect(existsSync(pausePath(root, 'a'))).toBe(true);
    expect(readPause(root, 'a')).toBe('deploying new config');
    // The breaker itself is still cleared — only the deliberate pause survives.
    const st = readState(root).jobs.a;
    expect(st.breakerTripped).toBeUndefined();
    expect(st.consecutiveFailures).toBe(0);
  });

  it('reports pauseCleared:false when there was no marker at all', () => {
    expect(resetBreaker(root, 'a')).toMatchObject({ cleared: true, pauseCleared: false });
  });
});
