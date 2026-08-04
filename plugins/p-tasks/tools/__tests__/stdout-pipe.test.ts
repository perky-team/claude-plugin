// Regression: `process.exit()` straight after `process.stdout.write()` truncates the
// output when stdout is a PIPE.
//
// Writes to a pipe are asynchronous in Node — the data is queued on the stream and
// flushed by the event loop — so `process.exit()` tears the process down with bytes
// still pending. Writes to a FILE are synchronous and arrive in full. That asymmetry is
// exactly why the bug survives manual checking: `ptasks list --json > out.json` looks
// perfect, while `ptasks list --json | consumer` delivers one pipe buffer of truncated
// JSON. Measured on a live 318-item board: 853 212 bytes to a file, 65 536 through a
// pipe, 145 901 through execFileSync.
//
// The consumer-visible failure is worse than a short file. JSON.parse throws on the
// truncated text, a careful caller catches it and reports "no data" — so a corrupt read
// is indistinguishable from an empty board, and a guard or an escalation list reads as
// all-clear when nothing was actually read.
//
// This file therefore asserts on the two things a caller depends on: the JSON parses,
// and it is byte-identical to what the same command writes to a file.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

vi.setConfig({ testTimeout: 30_000 });

const CLI = resolve(__dirname, '..', 'ptasks.mjs');
const ENV = { ...process.env, CLAUDE_PLUGIN_ROOT: resolve(__dirname, '..', '..') };
const PIPE_BUFFER = 65_536;

let dir: string;

/**
 * A board whose `list --json` output must cross several pipe buffers: 120 items with a
 * 3 KB description each is ~380 KB, six times the 64 KB the bug caps output at, so a
 * pass cannot be a lucky small payload.
 */
function seedBoard(count = 120) {
  spawnSync(process.execPath, [CLI, 'init', '--json'], { cwd: dir, encoding: 'utf-8', env: ENV });
  const description = 'x'.repeat(3000);
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `t-${i + 1}`,
    title: `Task ${i + 1}`,
    description,
    status: 'todo',
    blockedBy: [],
    subTasks: [],
  }));
  writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), yaml.dump({ tasks }), 'utf-8');
}

/** Run the CLI with stdout on a PIPE — how every programmatic consumer calls it. */
function throughPipe(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: ENV,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** Run the same CLI with stdout on a FILE — the path where the bug is invisible. */
function throughFile(args: string[]) {
  const out = join(dir, 'stdout.capture');
  const fd = openSync(out, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: ENV, stdio: ['ignore', fd, 'pipe'] });
    return { status: r.status, stdout: readFileSync(out, 'utf-8') };
  } finally {
    closeSync(fd);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-pipe-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('stdout survives a pipe', () => {
  it('the fixture actually exceeds a pipe buffer, or this suite proves nothing', () => {
    seedBoard();
    const file = throughFile(['list', '--json']);
    expect(file.status).toBe(0);
    expect(file.stdout.length).toBeGreaterThan(PIPE_BUFFER * 4);
  });

  it('list --json through a pipe is complete and parses', () => {
    seedBoard();
    const piped = throughPipe(['list', '--json']);

    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    // The failure mode this pins: JSON.parse throws on a half-written object, and the
    // caller's catch turns "corrupt" into "empty".
    const parsed = JSON.parse(piped.stdout);
    expect(parsed.items).toHaveLength(120);
    expect(parsed.items[119].id).toBe('t-120');
  });

  it('a pipe and a file receive byte-identical output', () => {
    seedBoard();
    const piped = throughPipe(['list', '--json']);
    const file = throughFile(['list', '--json']);

    expect(piped.stdout.length).toBe(file.stdout.length);
    expect(piped.stdout).toBe(file.stdout);
  });
});
