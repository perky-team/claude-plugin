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
});

describe('cli entry', () => {
  it('prints version', () => {
    expect(run(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('unknown command exits non-zero', () => {
    expect(() => run(['frobnicate'])).toThrow();
  });
});
