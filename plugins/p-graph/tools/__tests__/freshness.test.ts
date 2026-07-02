import { describe, it, expect } from 'vitest';
import { computeActionable, driftCount } from '../lib/freshness.mjs';

describe('computeActionable', () => {
  it('keeps only source files pgraph indexes, drops ignored / non-source', () => {
    const change = {
      modified: ['src/a.ts', 'README.md', 'node_modules/x/i.js', 'data.json'],
      deleted: ['src/b.ts', 'docs/notes.md'],
    };
    const act = computeActionable(change, []);
    expect(act.modified).toEqual(['src/a.ts']);       // README.md, data.json (non-source), node_modules (ignored) dropped
    expect(act.deleted).toEqual(['src/b.ts', 'docs/notes.md']); // deletions keep non-source (removeFile is a harmless no-op) but drop ignored
    expect(driftCount(act)).toBe(3);
  });

  it('drift is 0 when only non-source files changed', () => {
    const act = computeActionable({ modified: ['README.md'], deleted: [] }, []);
    expect(driftCount(act)).toBe(0);
  });
});
