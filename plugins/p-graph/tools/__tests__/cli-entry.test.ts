import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
const run = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf-8', ...opts });

describe('cli entry', () => {
  it('prints version', () => {
    expect(run(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('unknown command exits 1', () => {
    expect(() => run(['frobnicate'])).toThrow();
  });
});
