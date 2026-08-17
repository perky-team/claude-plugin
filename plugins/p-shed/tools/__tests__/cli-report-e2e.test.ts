import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// A path -> content-hash snapshot of every FILE under `dir`, at any depth. A top-level
// listing of `.pshed/` would miss a rewrite inside `state/`, `run/` or `logs/` — exactly
// the claim this command makes (read-only, disturbs nothing the running scheduler
// depends on) — so this walks the whole tree and hashes contents rather than trusting
// names or a directory listing alone.
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) { walk(full, rel); continue; }
      out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

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

  it('changes nothing under .pshed, at any depth', () => {
    // A top-level listing would not notice a state file rewritten inside state/,
    // run/ or logs/ — that "disturbs nothing the scheduler depends on" claim is the
    // branch's headline promise, so seed all three and compare recursively (B3).
    mkdirSync(join(root, '.pshed', 'state'), { recursive: true });
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'state', 'worker.json'),
      JSON.stringify({ lastRun: 1, lastExit: 0, pid: null, consecutiveFailures: 0 }));
    writeFileSync(join(root, '.pshed', 'run', 'worker.pid'), '12345\n');

    const before = snapshotDir(join(root, '.pshed'));
    run(['report']);
    expect(snapshotDir(join(root, '.pshed'))).toEqual(before);
  });

  it('exits 2 when --out has no value', () => {
    expect(run(['report', '--out']).code).toBe(2);
  });

  it('exits 1 when there is no .pshed directory', () => {
    rmSync(join(root, '.pshed'), { recursive: true, force: true });
    expect(run(['report']).code).toBe(1);
  });

  it('exits 2 on an invalid defaults.logRetentionDays', () => {
    writeFileSync(join(root, '.pshed', 'jobs.yml'),
      'version: 1\ndefaults:\n  logRetentionDays: -1\njobs:\n  - id: worker\n    schedule: "*/15 * * * *"\n    prompt: "x"\n');
    expect(run(['report']).code).toBe(2);
  });

  it('accepts logRetentionDays: 0 (keep everything)', () => {
    writeFileSync(join(root, '.pshed', 'jobs.yml'),
      'version: 1\ndefaults:\n  logRetentionDays: 0\njobs:\n  - id: worker\n    schedule: "*/15 * * * *"\n    prompt: "x"\n');
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('defaults the window to 7 days when nothing is configured', () => {
    const { out } = run(['report']);
    expect(out).toContain('Cost · 7 days');
    expect(out).toContain('Runs · 7 days');
    expect(out).toContain('window 7 days');
  });

  it('a configured retention widens the window and every heading follows it', () => {
    writeFileSync(join(root, '.pshed', 'jobs.yml'),
      'version: 1\ndefaults:\n  logRetentionDays: 30\njobs:\n  - id: worker\n    schedule: "*/15 * * * *"\n    prompt: "x"\n');
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    expect(out).toContain('Cost · 30 days');
    expect(out).toContain('Runs · 30 days');
    expect(out).toContain('window 30 days');
  });

  it('logRetentionDays: 0 shows every log present, however far back it goes', () => {
    // One old record, well outside the fixed 7-day window a bare "0" could be mistaken
    // for. The report must widen to reach it, not read 0 as "0-day window".
    writeFileSync(join(root, '.pshed', 'logs', '2026-07-01.jsonl'),
      JSON.stringify({ ts: new Date('2026-07-01T09:00:00').getTime(), job: 'worker', exit: 0, outcome: 'success', durationMs: 1000, usage: { costUsd: 3 } }) + '\n');
    writeFileSync(join(root, '.pshed', 'jobs.yml'),
      'version: 1\ndefaults:\n  logRetentionDays: 0\njobs:\n  - id: worker\n    schedule: "*/15 * * * *"\n    prompt: "x"\n');
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    // Never literally "0 days" — the page must show the real span it actually found.
    expect(out).not.toMatch(/window 0 days/);
    expect(out).not.toMatch(/Cost · 0 days/);
    // beforeEach seeds a $1.25 run on 2026-08-14; this test adds a $3 run on 2026-07-01.
    // Their sum only appears if the old file actually got read — proof the window widened.
    expect(out).toContain('$4.25');
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

  it('reports an unreadable log file separately from an unreadable line (A6)', () => {
    // A directory sitting where a dated log file is expected is unreadable exactly
    // like a permission error — the whole file, not a line inside it — so it must
    // not be folded into "line(s)", which would understate how much data is missing.
    mkdirSync(join(root, '.pshed', 'logs', '2026-08-12.jsonl'));
    const out = run(['report']).out;
    expect(out).toContain('1 unreadable log file(s)');
    expect(out).not.toContain('1 unreadable log line(s)');
  });
});
