import { describe, expect, it } from 'vitest';
import { parseArgs, findRoot } from '../ptasks.mjs';

describe('parseArgs', () => {
  it('parses positionals and flags', () => {
    expect(parseArgs(['add', 'task', '--title', 'x', '--json'])).toEqual({ _: ['add', 'task'], title: 'x', json: true });
  });
  it('parses --key=value form', () => {
    expect(parseArgs(['--title=x'])).toEqual({ _: [], title: 'x' });
  });
  it('repeats produce an array', () => {
    expect(parseArgs(['--mirror', 'a', '--mirror', 'b'])).toEqual({ _: [], mirror: ['a', 'b'] });
  });
});

describe('findRoot', () => {
  it('returns a string', () => {
    expect(typeof findRoot(process.cwd())).toBe('string');
  });
});
