import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingWork, defaultWorkDir, clearSnapshotRoot } from '../../scripts/measure-tracker.mjs';

describe('pendingWork', () => {
  it('lists every arm and run when nothing has been done', () => {
    expect(pendingWork([], { arms: ['none', 'ptasks'], runs: 2 }))
      .toEqual([
        { arm: 'none', run: 1 }, { arm: 'none', run: 2 },
        { arm: 'ptasks', run: 1 }, { arm: 'ptasks', run: 2 },
      ]);
  });

  it('skips a run that already has rows', () => {
    const rows = [{ arm: 'none', run: 1, session: 1 }];
    expect(pendingWork(rows, { arms: ['none'], runs: 2 })).toEqual([{ arm: 'none', run: 2 }]);
  });

  it('treats a run as done even if it stopped early, so restarts never redo work', () => {
    const rows = [{ arm: 'none', run: 1, session: 4 }];
    expect(pendingWork(rows, { arms: ['none'], runs: 1 })).toEqual([]);
  });
});

describe('defaultWorkDir', () => {
  it('uses the study\'s ordinary work directory when not smoke-testing', () => {
    expect(defaultWorkDir(['--pilot'])).toBe(join(tmpdir(), 'ptasks-measure'));
    expect(defaultWorkDir([])).toBe(join(tmpdir(), 'ptasks-measure'));
  });

  // The bug: without a directory of its own, --smoke's one row lands in the
  // same runs.jsonl as everything else, and a --pilot run right after reads
  // that row as a finished run and silently does nothing.
  it('uses a directory of its own for --smoke, so it cannot poison the real study', () => {
    expect(defaultWorkDir(['--smoke'])).toBe(join(tmpdir(), 'ptasks-measure-smoke'));
  });
});

describe('clearSnapshotRoot', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'snaproot-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  // The bug: cpSync merges into an existing destination rather than pruning
  // it, so re-running a suspect (arm, run) pair inherited every file the
  // earlier attempt wrote and the new one had not yet touched.
  it('removes a stale snapshot root left by an earlier attempt at the same run', () => {
    const snapRoot = join(work, 'snapshots', 'none-1');
    mkdirSync(join(snapRoot, 's00'), { recursive: true });
    writeFileSync(join(snapRoot, 's00', 'stale.js'), 'stale\n');

    const result = clearSnapshotRoot(work, 'none', 1);

    expect(result).toBe(snapRoot);
    expect(existsSync(join(snapRoot, 's00'))).toBe(false);
  });

  it('does not fail when there is nothing to clear yet', () => {
    expect(() => clearSnapshotRoot(work, 'ptasks', 3)).not.toThrow();
  });
});
