import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

describe('pwiki CLI entry', () => {
  it('prints version on --version', () => {
    const r = spawnSync('node', [cli, '--version'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1.0.0');
  });

  it('exits 1 on unknown command', () => {
    const r = spawnSync('node', [cli, 'bogus'], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown command/i);
  });
});
