import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs, timeoutMsFrom, pollMsFrom } from '../pshed.mjs';
import { ValidationError } from '../lib/jobs.mjs';

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

describe('timeoutMsFrom', () => {
  it('returns default when flag absent', () => {
    expect(timeoutMsFrom({})).toBe(1_800_000);
  });
  it('converts seconds to milliseconds', () => {
    expect(timeoutMsFrom({ 'timeout-sec': '30' })).toBe(30_000);
  });
  it('allows zero timeout (check once)', () => {
    expect(timeoutMsFrom({ 'timeout-sec': '0' })).toBe(0);
  });
  it('rejects valueless flag', () => {
    expect(() => timeoutMsFrom({ 'timeout-sec': true })).toThrow(ValidationError);
  });
  it('rejects non-numeric value', () => {
    expect(() => timeoutMsFrom({ 'timeout-sec': 'foo' })).toThrow(ValidationError);
  });
  it('rejects negative value', () => {
    expect(() => timeoutMsFrom({ 'timeout-sec': '-10' })).toThrow(ValidationError);
  });
});

describe('pollMsFrom', () => {
  it('returns default when flag absent', () => {
    expect(pollMsFrom({})).toBe(1000);
  });
  it('returns milliseconds as-is', () => {
    expect(pollMsFrom({ 'poll-ms': '500' })).toBe(500);
  });
  it('rejects valueless flag', () => {
    expect(() => pollMsFrom({ 'poll-ms': true })).toThrow(ValidationError);
  });
  it('rejects non-numeric value', () => {
    expect(() => pollMsFrom({ 'poll-ms': 'foo' })).toThrow(ValidationError);
  });
  it('rejects zero', () => {
    expect(() => pollMsFrom({ 'poll-ms': '0' })).toThrow(ValidationError);
  });
  it('rejects negative value', () => {
    expect(() => pollMsFrom({ 'poll-ms': '-1' })).toThrow(ValidationError);
  });
});
