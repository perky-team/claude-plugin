import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pobserve.mjs');
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-e2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('pobserve status (e2e)', () => {
  it('reports p-shed running jobs from a real .pshed tree', () => {
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'run', 'daily.pid'), '4321');
    const out = execFileSync('node', [CLI, 'status'], { cwd: root, encoding: 'utf-8' });
    expect(out).toMatch(/p-shed/);
    expect(out).toMatch(/running/);
  });
});
