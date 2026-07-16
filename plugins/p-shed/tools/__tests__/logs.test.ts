import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, rotateLogs } from '../lib/logs.mjs';
import { paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-logs-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const day = (s: string) => new Date(s + 'T12:00:00').getTime();

describe('appendLog', () => {
  it('writes one JSON line to the dated file', () => {
    appendLog(root, { job: 'a', exit: 0 }, day('2026-07-16'));
    const file = join(paths(root).logsDir, '2026-07-16.jsonl');
    expect(readFileSync(file, 'utf-8')).toBe('{"job":"a","exit":0}\n');
  });
});

describe('rotateLogs', () => {
  it('deletes files older than the retention window', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-01.jsonl'), 'x\n');   // 15 days old
    writeFileSync(join(dir, '2026-07-16.jsonl'), 'x\n');   // today
    const deleted = rotateLogs(root, day('2026-07-16'), 7);
    expect(deleted).toEqual(['2026-07-01.jsonl']);
    expect(existsSync(join(dir, '2026-07-01.jsonl'))).toBe(false);
    expect(existsSync(join(dir, '2026-07-16.jsonl'))).toBe(true);
  });

  it('keeps files at exact boundary (7 days old), deletes beyond (8+ days)', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-09.jsonl'), 'x\n');   // exactly 7 days old
    writeFileSync(join(dir, '2026-07-08.jsonl'), 'x\n');   // 8 days old
    const deleted = rotateLogs(root, day('2026-07-16'), 7);
    expect(deleted).toEqual(['2026-07-08.jsonl']);
    expect(existsSync(join(dir, '2026-07-09.jsonl'))).toBe(true);
    expect(existsSync(join(dir, '2026-07-08.jsonl'))).toBe(false);
  });

  it('returns empty array when logs directory does not exist', () => {
    const deleted = rotateLogs(root, day('2026-07-16'), 7);
    expect(deleted).toEqual([]);
  });

  it('ignores non-dated and non-jsonl files, deletes only matching pattern', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cron.log'), 'x\n');           // non-matching name
    writeFileSync(join(dir, 'notes.txt'), 'x\n');          // non-matching name
    writeFileSync(join(dir, '2026-01-01.jsonl'), 'x\n');   // very old dated file
    const deleted = rotateLogs(root, day('2026-07-16'), 7);
    expect(deleted).toEqual(['2026-01-01.jsonl']);
    expect(existsSync(join(dir, 'cron.log'))).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, '2026-01-01.jsonl'))).toBe(false);
  });
});
