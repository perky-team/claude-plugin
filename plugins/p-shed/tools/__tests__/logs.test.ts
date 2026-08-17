import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, rotateLogs, readLogRecords, resolveLogRetentionDays } from '../lib/logs.mjs';
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

  it('deletes nothing when retentionDays is 0 (keep forever)', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2020-01-01.jsonl'), 'x\n');   // years old
    writeFileSync(join(dir, '2026-07-16.jsonl'), 'x\n');   // today
    const deleted = rotateLogs(root, day('2026-07-16'), 0);
    expect(deleted).toEqual([]);
    expect(existsSync(join(dir, '2020-01-01.jsonl'))).toBe(true);
    expect(existsSync(join(dir, '2026-07-16.jsonl'))).toBe(true);
  });

  it('deletes nothing for a negative retentionDays either, instead of wiping every file', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-16.jsonl'), 'x\n');   // today — still being written
    const deleted = rotateLogs(root, day('2026-07-16'), -1);
    expect(deleted).toEqual([]);
    expect(existsSync(join(dir, '2026-07-16.jsonl'))).toBe(true);
  });

  it('honours a configured retention shorter than the historical default', () => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-14.jsonl'), 'x\n');   // 2 days old
    writeFileSync(join(dir, '2026-07-16.jsonl'), 'x\n');   // today
    const deleted = rotateLogs(root, day('2026-07-16'), 1);
    expect(deleted).toEqual(['2026-07-14.jsonl']);
    expect(existsSync(join(dir, '2026-07-16.jsonl'))).toBe(true);
  });
});

describe('resolveLogRetentionDays', () => {
  it('defaults to 7 when defaults.logRetentionDays is absent', () => {
    expect(resolveLogRetentionDays({})).toBe(7);
    expect(resolveLogRetentionDays(undefined)).toBe(7);
  });

  it('honours a configured value', () => {
    expect(resolveLogRetentionDays({ logRetentionDays: 30 })).toBe(30);
  });

  it('honours 0 (keep everything)', () => {
    expect(resolveLogRetentionDays({ logRetentionDays: 0 })).toBe(0);
  });

  it('falls back to 7 on a non-numeric value, without throwing', () => {
    expect(resolveLogRetentionDays({ logRetentionDays: 'forever' })).toBe(7);
  });

  it('falls back to 7 on a negative value, without throwing', () => {
    expect(resolveLogRetentionDays({ logRetentionDays: -5 })).toBe(7);
  });
});

describe('readLogRecords', () => {
  const write = (name: string, lines: string[]) => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), lines.join('\n') + '\n');
  };

  it('returns an empty result when there is no log directory', () => {
    expect(readLogRecords(root, 0)).toEqual({ records: [], skippedLines: 0, skippedFiles: 0 });
  });

  it('reads every dated file and sorts records oldest first', () => {
    write('2026-07-15.jsonl', [JSON.stringify({ ts: 200, job: 'b' })]);
    write('2026-07-16.jsonl', [JSON.stringify({ ts: 100, job: 'a' })]);
    const { records } = readLogRecords(root, 0);
    expect(records.map((r) => r.job)).toEqual(['a', 'b']);
  });

  it('drops records older than sinceMs without counting them as skipped', () => {
    write('2026-07-16.jsonl', [
      JSON.stringify({ ts: 100, job: 'old' }),
      JSON.stringify({ ts: 300, job: 'new' }),
    ]);
    const { records, skippedLines } = readLogRecords(root, 200);
    expect(records.map((r) => r.job)).toEqual(['new']);
    expect(skippedLines).toBe(0);
  });

  it('skips and counts a line that does not parse', () => {
    write('2026-07-16.jsonl', [JSON.stringify({ ts: 100, job: 'a' }), '{"ts":1,']);
    const { records, skippedLines, skippedFiles } = readLogRecords(root, 0);
    expect(records).toHaveLength(1);
    expect(skippedLines).toBe(1);
    expect(skippedFiles).toBe(0);
  });

  it('skips and counts a record with no numeric ts', () => {
    write('2026-07-16.jsonl', [JSON.stringify({ job: 'a' })]);
    expect(readLogRecords(root, 0)).toEqual({ records: [], skippedLines: 1, skippedFiles: 0 });
  });

  it('ignores files that are not dated jsonl', () => {
    write('2026-07-16.jsonl', [JSON.stringify({ ts: 100, job: 'a' })]);
    writeFileSync(join(paths(root).logsDir, 'cron.log'), 'noise\n');
    expect(readLogRecords(root, 0).records).toHaveLength(1);
  });

  it('counts a whole unreadable FILE separately from a bad line, not folded into it (A6)', () => {
    // A directory where a dated log file is expected is unreadable as a log for the
    // same reason a permission error is: readFileSync fails on the whole thing, not
    // on one line. Portable across Windows and POSIX, unlike chmod.
    write('2026-07-15.jsonl', [JSON.stringify({ ts: 100, job: 'a' })]);
    mkdirSync(join(paths(root).logsDir, '2026-07-16.jsonl'));
    const { records, skippedLines, skippedFiles } = readLogRecords(root, 0);
    expect(records.map((r) => r.job)).toEqual(['a']);
    expect(skippedFiles).toBe(1);
    expect(skippedLines).toBe(0);
  });
});
