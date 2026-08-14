import { describe, expect, it } from 'vitest';
import { pendingWork } from '../../scripts/measure-tracker.mjs';

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
