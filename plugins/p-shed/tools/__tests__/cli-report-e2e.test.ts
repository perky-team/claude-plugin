import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../pshed.mjs', import.meta.url));
let root: string;

const run = (args: string[]) => {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf-8' }), code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout ?? ''), code: e.status as number };
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pshed-report-'));
  mkdirSync(join(root, '.pshed', 'logs'), { recursive: true });
  writeFileSync(join(root, '.pshed', 'jobs.yml'),
    'version: 1\njobs:\n  - id: worker\n    schedule: "*/15 * * * *"\n    prompt: "x"\n');
  writeFileSync(join(root, '.pshed', 'logs', '2026-08-14.jsonl'),
    JSON.stringify({ ts: Date.now(), job: 'worker', exit: 0, outcome: 'success', durationMs: 1000, usage: { costUsd: 1.25 } }) + '\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('pshed report', () => {
  it('writes an HTML document to stdout', () => {
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('worker');
  });

  it('writes the file with --out and leaves no temp file behind', () => {
    const target = join(root, 'board.html');
    expect(run(['report', '--out', target]).code).toBe(0);
    expect(readFileSync(target, 'utf-8')).toContain('<!doctype html>');
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('changes nothing under .pshed', () => {
    const before = readdirSync(join(root, '.pshed')).sort();
    run(['report']);
    expect(readdirSync(join(root, '.pshed')).sort()).toEqual(before);
  });

  it('exits 2 when --out has no value', () => {
    expect(run(['report', '--out']).code).toBe(2);
  });

  it('exits 1 when there is no .pshed directory', () => {
    rmSync(join(root, '.pshed'), { recursive: true, force: true });
    expect(run(['report']).code).toBe(1);
  });

  it('exits 1 and leaves nothing behind when the target cannot be written', () => {
    const target = join(root, 'no-such-dir', 'board.html');
    expect(run(['report', '--out', target]).code).toBe(1);
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('renders a job that has never run', () => {
    writeFileSync(join(root, '.pshed', 'jobs.yml'),
      'version: 1\njobs:\n  - id: fresh\n    schedule: "0 9 * * *"\n    prompt: "x"\n');
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    expect(out).toContain('fresh');
  });

  it('reports unreadable log lines in the footer', () => {
    writeFileSync(join(root, '.pshed', 'logs', '2026-08-13.jsonl'), '{"ts":1,\n');
    expect(run(['report']).out).toContain('1 unreadable log line(s)');
  });
});
