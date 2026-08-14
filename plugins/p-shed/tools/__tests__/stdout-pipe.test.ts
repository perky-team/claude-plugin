// Regression: `process.exit()` straight after `process.stdout.write()` truncates the
// output when stdout is a PIPE. See the long note in p-tasks' copy of this file — the
// mechanism is identical and the fix is shared. p-shed matters most of the three: its
// `status --json` is what a watchdog polls, and a truncated read that JSON.parse rejects
// is reported by a careful caller as "no jobs", i.e. as a healthy loop.
//
// Note for anyone running this on Windows and finding it green: writes to a pipe are
// SYNCHRONOUS on Windows and asynchronous only on POSIX, so this bug cannot reproduce
// here at all. It must be run under WSL — see .claude/CLAUDE.md.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

vi.setConfig({ testTimeout: 30_000 });

const CLI = resolve(__dirname, '..', 'pshed.mjs');
const PIPE_BUFFER = 65_536;

let dir: string;

/**
 * A scheduler with enough jobs that `status --json` must cross several pipe buffers.
 * The bulk comes from each job's `breakerReason`, which `status` reports verbatim —
 * 150 jobs x ~2 KB is ~330 KB, five times the 64 KB the bug caps output at.
 */
function seedScheduler(count = 150) {
  const pshed = join(dir, '.pshed');
  mkdirSync(join(pshed, 'state'), { recursive: true });
  mkdirSync(join(pshed, 'run'), { recursive: true });
  const jobs = Array.from({ length: count }, (_, i) => ({
    id: `job-${i + 1}`,
    schedule: '* * * * *',
    prompt: `work item ${i + 1}`,
  }));
  writeFileSync(join(pshed, 'jobs.yml'), yaml.dump({ version: 1, defaults: {}, jobs }), 'utf-8');
  writeFileSync(join(pshed, 'config.json'), JSON.stringify({ nodeBin: 'node', claudeBin: 'claude' }), 'utf-8');
  const reason = `exit 1: ${'y'.repeat(2000)}`;
  for (const job of jobs) {
    writeFileSync(
      join(pshed, 'state', `${job.id}.json`),
      JSON.stringify({ lastRun: 1785823501997, lastExit: 1, pid: null, consecutiveFailures: 3, breakerTripped: true, breakerReason: reason }),
      'utf-8',
    );
  }
}

function throughPipe(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function throughFile(args: string[]) {
  const out = join(dir, 'stdout.capture');
  const fd = openSync(out, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, stdio: ['ignore', fd, 'pipe'] });
    return { status: r.status, stdout: readFileSync(out, 'utf-8') };
  } finally {
    closeSync(fd);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pshed-pipe-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('stdout survives a pipe', () => {
  it('the fixture actually exceeds a pipe buffer, or this suite proves nothing', () => {
    seedScheduler();
    const file = throughFile(['status']);
    expect(file.status).toBe(0);
    expect(file.stdout.length).toBeGreaterThan(PIPE_BUFFER * 4);
  });

  it('status through a pipe is complete and parses', () => {
    seedScheduler();
    const piped = throughPipe(['status']);

    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    const parsed = JSON.parse(piped.stdout);
    expect(parsed.action).toBe('status');
    expect(parsed.jobs).toHaveLength(150);
    expect(parsed.jobs[149].id).toBe('job-150');
  });

  it('a pipe and a file receive byte-identical output', () => {
    seedScheduler();
    const piped = throughPipe(['status']);
    const file = throughFile(['status']);

    expect(piped.stdout.length).toBe(file.stdout.length);
    expect(piped.stdout).toBe(file.stdout);
  });

  it('status --human survives a pipe too — the same write/exit pair, no JSON envelope', () => {
    seedScheduler();
    const piped = throughPipe(['status', '--human']);
    const file = throughFile(['status', '--human']);

    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    expect(piped.stdout).toBe(file.stdout);
    expect(piped.stdout.trimEnd().endsWith('-')).toBe(true); // last cell of the last row
  });

  it('report through a pipe is complete — the largest page this CLI writes', () => {
    // seedScheduler makes 150 breaker-tripped jobs whose reasons are ~2 KB each, so the
    // page is several hundred KB: far past the 64 KB a truncating exit caps output at.
    // Green on win32 no matter how broken the code is — pipe writes are synchronous
    // there. It only means something under WSL.
    seedScheduler();
    const piped = throughPipe(['report']);
    const file = throughFile(['report']);

    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    expect(piped.stdout).toBe(file.stdout);
    expect(piped.stdout.trimEnd().endsWith('</html>')).toBe(true);
  });
});
