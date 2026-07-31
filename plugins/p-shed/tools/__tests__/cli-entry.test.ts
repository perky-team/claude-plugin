import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from '../pshed.mjs';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');
const run = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });

describe('parseArgs', () => {
  it('parses positionals and flags', () => {
    expect(parseArgs(['run', 'job1', '--json'])).toEqual({ _: ['run', 'job1'], json: true });
  });
  it('parses --key=value', () => {
    expect(parseArgs(['--id=task-runner'])).toEqual({ _: [], id: 'task-runner' });
  });
  it('stops at a bare -- and returns the remainder verbatim', () => {
    expect(parseArgs(['--reason', 'fix', '--', 'git', 'commit', '-m', 'x'])).toEqual({
      _: [], reason: 'fix', '--': ['git', 'commit', '-m', 'x'],
    });
  });
  it('keeps flags after -- out of the parse (they belong to the command)', () => {
    expect(parseArgs(['--', 'npm', 'run', '--silent', 'build'])).toEqual({
      _: [], '--': ['npm', 'run', '--silent', 'build'],
    });
  });
  it('omits the -- key entirely when no terminator is present', () => {
    expect(parseArgs(['status', '--human'])).toEqual({ _: ['status'], human: true });
  });
  it('treats a trailing -- as an empty command list', () => {
    expect(parseArgs(['--reason', 'fix', '--'])).toEqual({ _: [], reason: 'fix', '--': [] });
  });
});

describe('cli entry', () => {
  it('prints version', () => {
    expect(run(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('unknown command exits non-zero', () => {
    expect(() => run(['frobnicate'])).toThrow();
  });
});
