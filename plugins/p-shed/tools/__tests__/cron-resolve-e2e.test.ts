// The generated crontab line, actually executed by a shell.
//
// POSIX-only, and that is the point: `install-cron` is POSIX logic with a separate win32
// branch, so a Windows run proves nothing about it. Per .claude/CLAUDE.md these
// `skipIf(win32)` tests are verified NOWHERE unless the suite is also run under WSL —
// which is exactly what the two claims below need, since they are about how `sh` and
// coreutils behave under cron's stripped environment.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crontabLine, taskName } from '../lib/scheduler.mjs';

let root: string;
let cache: string;

// Strip the schedule prefix and the trailing marker: what is left is what cron hands to
// /bin/sh -c.
function shellCommand(line: string) {
  return line.replace(/^\* \* \* \* \* /, '').replace(new RegExp(` # ${taskName(root)}$`), '');
}

function fakeTool(version: string) {
  const dir = join(cache, 'p-shed', version, 'tools');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pshed.mjs');
  writeFileSync(p, `console.log(process.argv[2] + ' from ${version}');\n`, 'utf-8');
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pshed-cronres-'));
  cache = mkdtempSync(join(tmpdir(), 'pshed-cache-'));
  mkdirSync(join(root, '.pshed', 'logs'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('generated cron line (POSIX)', () => {
  // Cron's environment is not a login shell's: run with `env -i` plus only the PATH cron
  // itself sets, so anything the line assumes is resolvable by name has to actually be
  // there.
  const runUnderCronEnv = (command: string) =>
    execFileSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', '/bin/sh', '-c', command], { encoding: 'utf-8' });

  it('runs the tool with a stripped PATH and writes to the cron log', () => {
    const toolPath = fakeTool('0.10.0');
    runUnderCronEnv(shellCommand(crontabLine({ root, nodeBin: process.execPath, toolPath })));
    expect(readFileSync(join(root, '.pshed', 'logs', 'cron.log'), 'utf-8')).toContain('tick from 0.10.0');
  });

  it('still resolves after the version directory is renamed — the whole point', () => {
    const toolPath = fakeTool('0.10.0');
    const line = crontabLine({ root, nodeBin: process.execPath, toolPath });
    renameSync(join(cache, 'p-shed', '0.10.0'), join(cache, 'p-shed', '0.11.0'));
    runUnderCronEnv(shellCommand(line));
    expect(readFileSync(join(root, '.pshed', 'logs', 'cron.log'), 'utf-8')).toContain('tick from 0.11.0');
  });

  it('picks the newest version, not the lexicographically largest', () => {
    // The trap: 0.9.0 sorts AFTER 0.10.0 as a plain string. `sort -V` is what makes this
    // right, and a shell glob alone would get it wrong.
    const toolPath = fakeTool('0.9.0');
    fakeTool('0.10.0');
    runUnderCronEnv(shellCommand(crontabLine({ root, nodeBin: process.execPath, toolPath })));
    expect(readFileSync(join(root, '.pshed', 'logs', 'cron.log'), 'utf-8')).toContain('tick from 0.10.0');
  });

  it('falls back to the literal path when the glob matches nothing at all', () => {
    const toolPath = fakeTool('0.10.0');
    const line = crontabLine({ root, nodeBin: process.execPath, toolPath });
    renameSync(join(cache, 'p-shed'), join(cache, 'p-shed-moved'));
    // The resolver finds nothing; ${P:-<literal>} keeps today's behaviour. Restore the
    // literal target so the fallback has something to run.
    renameSync(join(cache, 'p-shed-moved'), join(cache, 'p-shed-x'));
    mkdirSync(join(cache, 'p-shed', '0.10.0'), { recursive: true });
    renameSync(join(cache, 'p-shed-x', '0.10.0', 'tools'), join(cache, 'p-shed', '0.10.0', 'tools'));
    runUnderCronEnv(shellCommand(line));
    expect(readFileSync(join(root, '.pshed', 'logs', 'cron.log'), 'utf-8')).toContain('tick from 0.10.0');
  });

  it('a non-versioned (dev checkout) path runs exactly as before', () => {
    const dir = join(cache, 'devtools');
    mkdirSync(dir, { recursive: true });
    const toolPath = join(dir, 'pshed.mjs');
    writeFileSync(toolPath, "console.log(process.argv[2] + ' from dev');\n", 'utf-8');
    runUnderCronEnv(shellCommand(crontabLine({ root, nodeBin: process.execPath, toolPath })));
    expect(readFileSync(join(root, '.pshed', 'logs', 'cron.log'), 'utf-8')).toContain('tick from dev');
  });
});
