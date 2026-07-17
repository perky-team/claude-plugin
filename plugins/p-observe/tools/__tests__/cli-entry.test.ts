import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pobserve.mjs');
const run = (args: string[]) => execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });

describe('pobserve CLI entry', () => {
  it('prints usage for help', () => {
    expect(run(['help'])).toMatch(/pobserve (watch|status|capture)/);
  });
  it('prints usage with no args', () => {
    expect(run([])).toMatch(/Usage:/);
  });
  it('exits non-zero on unknown command', () => {
    expect(() => run(['bogus'])).toThrow();
  });
});
