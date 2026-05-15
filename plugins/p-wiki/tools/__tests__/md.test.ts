import { describe, expect, it } from 'vitest';
import { sanitize } from '../lib/md.mjs';

describe('md.sanitize', () => {
  it('wraps bare <word> in backticks', () => {
    expect(sanitize('Replace <tenant> in the config')).toBe('Replace `<tenant>` in the config');
  });

  it('wraps multiple tokens', () => {
    expect(sanitize('<a> and <b-c>')).toBe('`<a>` and `<b-c>`');
  });

  it('does not touch tokens already in inline code', () => {
    expect(sanitize('Use `<placeholder>` here')).toBe('Use `<placeholder>` here');
  });

  it('does not touch tokens inside a fenced block', () => {
    const input = 'Text\n```\n<inside>\n```\nAfter';
    expect(sanitize(input)).toBe(input);
  });

  it('ignores non-word content between angle brackets', () => {
    expect(sanitize('a < 1ms and <3 hearts')).toBe('a < 1ms and <3 hearts');
  });

  it('returns the input unchanged when no bare token present', () => {
    expect(sanitize('plain text with no placeholders')).toBe('plain text with no placeholders');
  });

  it('handles bare token at start and end', () => {
    expect(sanitize('<start> middle <end>')).toBe('`<start>` middle `<end>`');
  });
});
