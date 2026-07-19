import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pausePath, readPause, resetBreaker } from '../lib/breaker.mjs';
import { paths, writeJobState, readState } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-breaker-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writePauseFile(id: string, body: string) {
  mkdirSync(paths(root).runDir, { recursive: true });
  writeFileSync(pausePath(root, id), body, 'utf-8');
}

describe('readPause', () => {
  it('returns the marker contents, or null when absent', () => {
    expect(readPause(root, 'a')).toBeNull();
    writePauseFile('a', 'verify went red');
    expect(readPause(root, 'a')).toBe('verify went red');
  });
});

describe('resetBreaker', () => {
  it('clears breaker state fields, zeroes the counter, and removes the pause marker', () => {
    writeJobState(root, 'a', {
      lastRun: 1, lastExit: 1, pid: null,
      consecutiveFailures: 5, breakerTripped: true, breakerReason: 'exit 1', breakerAt: 123,
    });
    writePauseFile('a', 'stuck');

    resetBreaker(root, 'a');

    const st = readState(root).jobs.a;
    expect(st.breakerTripped).toBeUndefined();
    expect(st.breakerReason).toBeUndefined();
    expect(st.breakerAt).toBeUndefined();
    expect(st.consecutiveFailures).toBe(0);
    expect(existsSync(pausePath(root, 'a'))).toBe(false);
  });

  it('works when there is no state file (just removes the pause marker)', () => {
    writePauseFile('a', 'stuck');
    expect(() => resetBreaker(root, 'a')).not.toThrow();
    expect(existsSync(pausePath(root, 'a'))).toBe(false);
  });
});
