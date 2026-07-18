import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, replayJournal, rotateJournal } from '../lib/journal.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pobs-jrnl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const day = (s: string) => new Date(s + 'T12:00:00Z').getTime();

describe('journal round-trip', () => {
  it('append then replay returns equal events, skipping junk lines', () => {
    const e1 = { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} };
    const e2 = { ts: 2, plugin: 'p-tasks', kind: 'task.status', entity: 'T', severity: 'info', summary: 'y', data: {} };
    appendJournal(dir, e1, day('2026-07-16'));
    appendJournal(dir, e2, day('2026-07-16'));
    // corrupt trailing line tolerated
    appendFileSync(join(dir, '2026-07-16.jsonl'), '{ half\n');
    expect(replayJournal(dir)).toEqual([e1, e2]);
  });

  it('replay returns [] when the dir is absent', () => {
    expect(replayJournal(join(dir, 'nope'))).toEqual([]);
  });

  it('concatenates multiple dated files in ascending (chronological) order', () => {
    const e1 = { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} };
    const e2 = { ts: 2, plugin: 'p-shed', kind: 'job.finished', entity: 'b', severity: 'ok', summary: 'y', data: {} };
    appendJournal(dir, e1, day('2026-07-01'));
    appendJournal(dir, e2, day('2026-07-16'));
    expect(replayJournal(dir)).toEqual([e1, e2]);
  });

  it('creates the journal dir on first append', () => {
    const target = join(dir, 'nested');
    appendJournal(target, { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} }, day('2026-07-16'));
    expect(existsSync(join(target, '2026-07-16.jsonl'))).toBe(true);
  });
});

describe('rotateJournal', () => {
  it('deletes files older than the retention window, keeps the boundary file', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-09.jsonl'), 'x\n'); // exactly 7 days old
    writeFileSync(join(dir, '2026-07-08.jsonl'), 'x\n'); // 8 days old
    const deleted = rotateJournal(dir, day('2026-07-16'), 7);
    expect(deleted).toEqual(['2026-07-08.jsonl']);
    expect(existsSync(join(dir, '2026-07-09.jsonl'))).toBe(true);
    expect(existsSync(join(dir, '2026-07-08.jsonl'))).toBe(false);
  });

  it('returns [] when the journal dir does not exist', () => {
    expect(rotateJournal(join(dir, 'nope'), day('2026-07-16'), 7)).toEqual([]);
  });

  it('ignores non-dated files', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'x\n');
    writeFileSync(join(dir, '2026-01-01.jsonl'), 'x\n');
    const deleted = rotateJournal(dir, day('2026-07-16'), 7);
    expect(deleted).toEqual(['2026-01-01.jsonl']);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});
