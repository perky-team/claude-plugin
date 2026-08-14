import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTap, scoreSnapshot, expectedTests, resultFrom }
  from '../../scripts/measure-tracker/score.mjs';
import { repoRoot } from '../../../../tests/helpers';

describe('parseTap', () => {
  it('keys every test by its full name', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - R1 reads a section',
      'not ok 2 - R2 sorts errors by path',
    ].join('\n');
    expect(parseTap(tap)).toEqual({
      'R1 reads a section': true,
      'R2 sorts errors by path': false,
    });
  });

  it('ignores indented subtest lines', () => {
    expect(parseTap('    ok 1 - inner\nok 2 - outer\n')).toEqual({ outer: true });
  });

  it('is empty for output with no test lines', () => {
    expect(parseTap('TAP version 13\n')).toEqual({});
  });
});

// A tiny two-test suite stands in for the real one: the behaviour under test is
// the filling and the null case, not the polygon.
const fixture = (dir: string, body: string) => {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'parse.js'), body);
  const acceptance = join(dir, 'acceptance.test.js');
  writeFileSync(acceptance, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { parseIni } from './src/parse.js';",
    "test('R1 returns an object', () => { assert.deepEqual(parseIni(''), {}); });",
    "test('R2 is not done', () => { assert.equal(1, 2); });",
  ].join('\n'));
  return acceptance;
};

describe('scoreSnapshot', () => {
  it('reports what the run said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'score-'));
    try {
      const acceptance = fixture(dir, 'export const parseIni = () => ({});\n');
      expect(scoreSnapshot({
        snapshotDir: dir,
        acceptanceFile: acceptance,
        expected: ['R1 returns an object', 'R2 is not done'],
      })).toEqual({ 'R1 returns an object': true, 'R2 is not done': false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('counts a test that never ran as false, not as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'score-'));
    try {
      // An import error kills the runner before either test reports.
      const acceptance = fixture(dir, 'throw new Error("broken");\n');
      expect(scoreSnapshot({
        snapshotDir: dir,
        acceptanceFile: acceptance,
        expected: ['R1 returns an object', 'R2 is not done'],
      })).toEqual({ 'R1 returns an object': false, 'R2 is not done': false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('resultFrom', () => {
  it('is null when the runner produced no TAP at all', () => {
    expect(resultFrom('', ['R1 a'])).toBeNull();
    expect(resultFrom('spawn ENOENT\n', ['R1 a'])).toBeNull();
  });

  it('is all red, not null, when the runner started and reported nothing green', () => {
    expect(resultFrom('TAP version 13\nnot ok 1 - acceptance.test.js\n', ['R1 a', 'R2 b']))
      .toEqual({ 'R1 a': false, 'R2 b': false });
  });

  it('ignores a name the study did not ask for', () => {
    expect(resultFrom('TAP version 13\nok 1 - R9 stray\n', ['R1 a']))
      .toEqual({ 'R1 a': false });
  });
});

describe('expectedTests', () => {
  it('takes the list from the reference implementation, where all are green', () => {
    const scripts = join(repoRoot(), 'plugins', 'p-tasks', 'scripts');
    const names = expectedTests({
      referenceDir: join(scripts, 'polygon-reference'),
      acceptanceFile: join(scripts, 'polygon-acceptance', 'acceptance.test.js'),
    });
    expect(names.length).toBeGreaterThan(30);
    expect(names.every((n) => /^R\d+ /.test(n))).toBe(true);
  }, 60_000);
});
