// Regression: `process.exit()` straight after `process.stdout.write()` truncates the
// output when stdout is a PIPE. See the long note in p-tasks' copy of this file — the
// mechanism is identical and the fix is shared. p-wiki reaches the threshold with a
// single command: `get --format=json` returns a page's whole body, so one long page is
// enough, no result-count arithmetic needed.
//
// Note for anyone running this on Windows and finding it green: writes to a pipe are
// SYNCHRONOUS on Windows and asynchronous only on POSIX, so this bug cannot reproduce
// here at all. It must be run under WSL — see .claude/CLAUDE.md.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.setConfig({ testTimeout: 30_000 });

const CLI = resolve(__dirname, '..', 'pwiki.mjs');
const PIPE_BUFFER = 65_536;
const PAGE_PATH = 'docs/wiki/pages/concept/kafka.md';

let dir: string;

/**
 * One page whose body alone is ~400 KB, six times the 64 KB the bug caps output at, so a
 * pass cannot be a lucky small payload. The body is many distinct lines rather than one
 * long run of a single character, so a truncation is visible as a missing tail marker
 * and not only as a length mismatch.
 */
function seedWiki(lines = 8000) {
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  const body = Array.from({ length: lines }, (_, i) => `Line ${i + 1}: ${'k'.repeat(40)}`).join('\n');
  const page = [
    '---',
    'id: kafka',
    'type: concept',
    'title: Kafka',
    'created: 2026-05-01',
    'updated: 2026-05-01',
    'status: active',
    'tags: [streaming]',
    'sources: []',
    '---',
    '',
    '# Kafka',
    '',
    body,
    '',
    'END-OF-PAGE-MARKER',
    '',
  ].join('\n');
  writeFileSync(join(dir, ...PAGE_PATH.split('/')), page, 'utf-8');
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
  dir = mkdtempSync(join(tmpdir(), 'pwiki-pipe-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('stdout survives a pipe', () => {
  it('the fixture actually exceeds a pipe buffer, or this suite proves nothing', () => {
    seedWiki();
    const file = throughFile(['get', PAGE_PATH, '--format=json']);
    expect(file.status).toBe(0);
    expect(file.stdout.length).toBeGreaterThan(PIPE_BUFFER * 4);
  });

  it('get --format=json through a pipe is complete and parses', () => {
    seedWiki();
    const piped = throughPipe(['get', PAGE_PATH, '--format=json']);

    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    const parsed = JSON.parse(piped.stdout);
    expect(parsed.path).toBe(PAGE_PATH);
    expect(parsed.frontmatter.id).toBe('kafka');
    expect(parsed.body).toContain('END-OF-PAGE-MARKER');
  });

  it('a pipe and a file receive byte-identical output', () => {
    seedWiki();
    const piped = throughPipe(['get', PAGE_PATH, '--format=json']);
    const file = throughFile(['get', PAGE_PATH, '--format=json']);

    expect(piped.stdout.length).toBe(file.stdout.length);
    expect(piped.stdout).toBe(file.stdout);
  });

  it('the text format survives a pipe too — the same write/exit pair, no JSON envelope', () => {
    seedWiki();
    const piped = throughPipe(['get', PAGE_PATH]);
    const file = throughFile(['get', PAGE_PATH]);

    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    expect(piped.stdout).toBe(file.stdout);
    expect(piped.stdout).toContain('END-OF-PAGE-MARKER');
  });
});
