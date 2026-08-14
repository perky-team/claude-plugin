import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../../../tests/helpers';

const SCRIPTS = join(repoRoot(), 'plugins', 'p-tasks', 'scripts');
const ACCEPTANCE = join(SCRIPTS, 'polygon-acceptance', 'acceptance.test.js');

function passRate(projectDir: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'polygon-gate-'));
  try {
    cpSync(projectDir, dir, { recursive: true });
    cpSync(ACCEPTANCE, join(dir, 'acceptance.test.js'));
    const r = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', 'acceptance.test.js'],
      { cwd: dir, encoding: 'utf-8' });
    const out = r.stdout ?? '';
    const ok = [...out.matchAll(/^ok \d+ - R\d+/gm)].length;
    const notOk = [...out.matchAll(/^not ok \d+ - R\d+/gm)].length;
    expect(ok + notOk).toBeGreaterThan(0);
    return ok / (ok + notOk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the hidden suite is real ground truth', () => {
  it('passes completely against the reference implementation', () => {
    expect(passRate(join(SCRIPTS, 'polygon-reference'))).toBe(1);
  }, 60_000);

  it('mostly fails against the bare seed, so it discriminates', () => {
    expect(passRate(join(SCRIPTS, 'polygon'))).toBeLessThan(0.15);
  }, 60_000);
});
