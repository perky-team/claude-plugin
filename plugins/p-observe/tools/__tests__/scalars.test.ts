import { describe, expect, it } from 'vitest';
import { scalarValue, unquote } from '../lib/adapters/scalars.mjs';

describe('unquote', () => {
  it('strips matching surrounding quotes only', () => {
    expect(unquote(`'hi'`)).toBe('hi');
    expect(unquote(`"hi"`)).toBe('hi');
    expect(unquote(`hi`)).toBe('hi');
    expect(unquote(`'mismatched"`)).toBe(`'mismatched"`);
  });
});

describe('scalarValue', () => {
  it('returns an inline value', () => {
    const lines = ['    model: sonnet'];
    expect(scalarValue(lines, 0)).toBe('sonnet');
  });
  it('unquotes an inline value', () => {
    const lines = [`    schedule: '0 9 * * *'`];
    expect(scalarValue(lines, 0)).toBe('0 9 * * *');
  });
  it('reads the first content line of a block scalar', () => {
    const lines = ['    prompt: |-', '      do the thing', '      then stop'];
    expect(scalarValue(lines, 0)).toBe('do the thing');
  });
  it('handles folded and keep/strip indicators', () => {
    expect(scalarValue(['    p: >2', '      folded text'], 0)).toBe('folded text');
    expect(scalarValue(['    p: |+', '      kept'], 0)).toBe('kept');
  });
  it('returns empty string when there is no value and no following line', () => {
    expect(scalarValue(['    p: |-'], 0)).toBe('');
    expect(scalarValue(['    nope'], 0)).toBe('');
  });
});
