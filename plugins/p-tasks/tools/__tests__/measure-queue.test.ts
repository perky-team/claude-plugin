import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pendingWork, defaultWorkDir, clearSnapshotRoot, endReason, assertAccounted,
} from '../../scripts/measure-tracker.mjs';

describe('pendingWork', () => {
  it('lists every arm and run when nothing has been done', () => {
    expect(pendingWork([], { arms: ['none', 'ptasks'], runs: 2 }))
      .toEqual([
        { arm: 'none', run: 1 }, { arm: 'none', run: 2 },
        { arm: 'ptasks', run: 1 }, { arm: 'ptasks', run: 2 },
      ]);
  });

  it('skips a run whose last row is marked ended', () => {
    const rows = [{ arm: 'none', run: 1, session: 1, ended: 'all-green' }];
    expect(pendingWork(rows, { arms: ['none'], runs: 2 })).toEqual([{ arm: 'none', run: 2 }]);
  });

  // The bug this guards: a run the spend brake or a crash cut off mid-flight
  // still has rows on disk. Treating mere presence as "finished" freezes that
  // run forever — raising the money limit and restarting would never redo it.
  it('treats a run as still pending when none of its rows are marked ended', () => {
    const rows = [{ arm: 'none', run: 1, session: 4 }];
    expect(pendingWork(rows, { arms: ['none'], runs: 1 })).toEqual([{ arm: 'none', run: 1 }]);
  });

  it('treats a run as done once its last row carries an ended reason', () => {
    const rows = [{ arm: 'none', run: 1, session: 4, ended: 'sessions-exhausted' }];
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

describe('endReason', () => {
  it('is all-green when every hidden test passed this session', () => {
    expect(endReason({ doneNow: true, consecutiveErrors: 0, session: 4, sessions: 10 }))
      .toBe('all-green');
  });

  it('is three-strikes after three sessions in a row have errored', () => {
    expect(endReason({ doneNow: false, consecutiveErrors: 3, session: 5, sessions: 10 }))
      .toBe('three-strikes');
  });

  it('is sessions-exhausted on the last session, if nothing else ended it first', () => {
    expect(endReason({ doneNow: false, consecutiveErrors: 0, session: 10, sessions: 10 }))
      .toBe('sessions-exhausted');
  });

  it('is undefined mid-run, so a row written there stays pending', () => {
    expect(endReason({ doneNow: false, consecutiveErrors: 1, session: 4, sessions: 10 }))
      .toBeUndefined();
  });
});

describe('assertAccounted', () => {
  // The bug: the spend brake sums cost_usd, so a row with neither an error
  // nor a cost is invisible to it — it looks like a session that was free.
  it('throws when a row reports neither an error nor a cost', () => {
    expect(() => assertAccounted({ error: null, cost_usd: null }))
      .toThrow(/account for what it is spending/);
  });

  it('does not throw when a row carries a cost', () => {
    expect(() => assertAccounted({ error: null, cost_usd: 0.12 })).not.toThrow();
  });

  it('does not throw when a row carries an error', () => {
    expect(() => assertAccounted({ error: 'boom', cost_usd: null })).not.toThrow();
  });
});
