import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../../../tests/helpers';

const SCRIPTS = join(repoRoot(), 'plugins', 'p-tasks', 'scripts');
const ACCEPTANCE = join(SCRIPTS, 'polygon-acceptance', 'acceptance.test.js');

// How many tests the hidden suite holds. Update this number whenever the suite
// grows or shrinks — that is the point. The gate has to notice a test that was
// deleted, renamed out of the `R<digit>` filter, or never ran because the runner
// died half way, and a bare "some tests ran" check notices none of those.
const TEST_COUNT = 37;

// Every requirement in SPEC.md needs at least one test of its own.
const IDS = Array.from({ length: 10 }, (_, i) => `R${i + 1}`);

interface SuiteRun {
  ok: number;
  notOk: number;
  names: string[];
  misnamed: string[];
}

function runSuite(projectDir: string): SuiteRun {
  const dir = mkdtempSync(join(tmpdir(), 'polygon-gate-'));
  try {
    cpSync(projectDir, dir, { recursive: true });
    cpSync(ACCEPTANCE, join(dir, 'acceptance.test.js'));
    const r = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', 'acceptance.test.js'],
      { cwd: dir, encoding: 'utf-8' });
    const out = r.stdout ?? '';
    const line = (re: RegExp) => [...out.matchAll(re)];
    return {
      ok: line(/^ok \d+ - R\d+/gm).length,
      notOk: line(/^not ok \d+ - R\d+/gm).length,
      names: line(/^(?:not )?ok \d+ - (.+)$/gm).map((m) => m[1].trim()),
      misnamed: line(/^(?:not )?ok \d+ - (?!R\d).*$/gm).map((m) => m[0].trim()),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One reference run, reused by the tests below.
let cached: SuiteRun | undefined;
const reference = (): SuiteRun => (cached ??= runSuite(join(SCRIPTS, 'polygon-reference')));

function passRate(run: SuiteRun): number {
  expect(run.ok + run.notOk).toBeGreaterThan(0);
  return run.ok / (run.ok + run.notOk);
}

describe('the hidden suite is real ground truth', () => {
  it('passes completely against the reference implementation', () => {
    expect(passRate(reference())).toBe(1);
  }, 60_000);

  it('is intact: every test ran, every requirement is covered, every name is tagged', () => {
    const run = reference();
    // Nothing was deleted, and the runner did not stop early.
    expect(run.ok + run.notOk).toBe(TEST_COUNT);
    expect(run.names).toHaveLength(TEST_COUNT);
    // Each requirement still has a test. `R1 ` with the space does not match `R10 `.
    for (const id of IDS) {
      expect(run.names.filter((n) => n.startsWith(`${id} `)).length,
        `no test for ${id}`).toBeGreaterThan(0);
    }
    // A test renamed without its id would drop out of the counts above unseen.
    expect(run.misnamed).toEqual([]);
  }, 60_000);

  it('mostly fails against the bare seed, so it discriminates', () => {
    expect(passRate(runSuite(join(SCRIPTS, 'polygon')))).toBeLessThan(0.15);
  }, 60_000);
});
