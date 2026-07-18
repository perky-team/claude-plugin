import { describe, expect, it } from 'vitest';
import { visibleWidth, fit, HOME, ENTER_ALT } from '../lib/tui/ansi.mjs';

describe('visibleWidth', () => {
  it('ignores ANSI color escapes', () => {
    expect(visibleWidth('\x1b[32mok\x1b[0m')).toBe(2);
    expect(visibleWidth('plain')).toBe(5);
  });
});

describe('fit', () => {
  it('pads short strings to width', () => {
    expect(fit('ab', 5)).toBe('ab   ');
    expect(visibleWidth(fit('ab', 5))).toBe(5);
  });
  it('truncates long plain strings to width', () => {
    expect(fit('abcdef', 4)).toBe('abcd');
  });
  it('truncates colored strings by visible width and resets', () => {
    const out = fit('\x1b[32mabcdef\x1b[0m', 4);
    expect(visibleWidth(out)).toBe(4);
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });
  it('exposes screen control constants', () => {
    expect(HOME).toBe('\x1b[H');
    expect(ENTER_ALT).toContain('1049');
  });
});
