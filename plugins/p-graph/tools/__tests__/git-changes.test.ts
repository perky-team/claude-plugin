import { describe, it, expect } from 'vitest';
import { parseGitChanges } from '../lib/index/build.mjs';

describe('parseGitChanges', () => {
  it('handles modified, deleted, added', () => {
    const r = parseGitChanges('M\tsrc/a.ts\nD\tsrc/b.ts\nA\tsrc/c.ts', '');
    expect(r.modified.sort()).toEqual(['src/a.ts', 'src/c.ts']);
    expect(r.deleted).toEqual(['src/b.ts']);
  });
  it('handles committed renames (tab-separated R100 old new)', () => {
    const r = parseGitChanges('R100\tsrc/old.ts\tsrc/new.ts', '');
    expect(r.modified).toContain('src/new.ts');
    expect(r.deleted).toContain('src/old.ts');
  });
  it('handles working-tree rename arrow in porcelain', () => {
    const r = parseGitChanges('', 'R  src/old.ts -> src/new.ts');
    expect(r.modified).toContain('src/new.ts');
    expect(r.deleted).toContain('src/old.ts');
  });
  it('a path that is both modified and deleted ends up modified only', () => {
    const r = parseGitChanges('A\tx.ts', 'D  x.ts');
    expect(r.modified).toContain('x.ts');
    expect(r.deleted).not.toContain('x.ts');
  });
});
