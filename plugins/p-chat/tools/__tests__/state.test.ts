import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, paths } from '../lib/config.mjs';
import { ackUntil, appendLocalLog, ensureGitignore, readOffset, resetSession, sessionPath, sessionStatus, writeOffset } from '../lib/state.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pchat-state-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('offset state', () => {
  it('reads a zero cursor when no offset file exists', () => {
    expect(readOffset(root)).toEqual({ confirmed: 0, lastPollAt: null });
  });

  it('round-trips the cursor', () => {
    writeOffset(root, { confirmed: 42, lastPollAt: 1000 });
    expect(readOffset(root)).toEqual({ confirmed: 42, lastPollAt: 1000 });
  });

  it('tolerates a corrupt offset file (treated as zero)', () => {
    mkdirSync(paths(root).dir, { recursive: true });
    writeFileSync(paths(root).offset, '{oops', 'utf-8');
    expect(readOffset(root).confirmed).toBe(0);
  });

  it('ackUntil advances the cursor and is idempotent at the same id', () => {
    writeOffset(root, { confirmed: 10, lastPollAt: null });
    expect(ackUntil(root, 15).confirmed).toBe(15);
    expect(ackUntil(root, 15).confirmed).toBe(15);
  });

  it('ackUntil REFUSES to move backwards (monotonicity)', () => {
    writeOffset(root, { confirmed: 10, lastPollAt: null });
    expect(() => ackUntil(root, 5)).toThrow(ConfigError);
    expect(readOffset(root).confirmed).toBe(10);
  });

  it('ackUntil rejects non-integer ids', () => {
    expect(() => ackUntil(root, NaN)).toThrow(ConfigError);
    expect(() => ackUntil(root, 1.5)).toThrow(ConfigError);
  });
});

describe('session + local log + gitignore', () => {
  const cfg = { sessionFile: '.pchat/session.md' };

  it('resetSession truncates (and creates) the session file', () => {
    const p = resetSession(root, cfg);
    expect(p).toBe(sessionPath(root, cfg));
    writeFileSync(p, 'Q/A history', 'utf-8');
    expect(sessionStatus(root, cfg).bytes).toBeGreaterThan(0);
    resetSession(root, cfg);
    expect(sessionStatus(root, cfg).bytes).toBe(0);
  });

  it('sessionStatus reports 0 bytes for a missing file', () => {
    expect(sessionStatus(root, cfg).bytes).toBe(0);
  });

  it('appendLocalLog appends JSONL records', () => {
    appendLocalLog(root, { ts: 1, event: 'skipped-update' });
    appendLocalLog(root, { ts: 2, event: 'split' });
    const lines = readFileSync(paths(root).log, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('skipped-update');
  });

  it('ensureGitignore adds .pchat/ once', () => {
    expect(ensureGitignore(root)).toBe(true);
    expect(ensureGitignore(root)).toBe(false);
    const gi = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gi.match(/\.pchat\//g)).toHaveLength(1);
  });
});
