import { describe, expect, it } from 'vitest';
import { sanitize, inlineCodeRanges } from '../lib/md.mjs';

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

describe('inlineCodeRanges', () => {
  it('returns a range for a single-backtick span', () => {
    // "`foo`" at offset 0: range [0, 5)
    const ranges = inlineCodeRanges('`foo`');
    expect(ranges).toEqual([[0, 5]]);
  });

  it('returns a range for a double-backtick span containing an interior backtick', () => {
    // ``a ` b`` — the whole span is one code range
    const text = '``a ` b``';
    const ranges = inlineCodeRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[0][1]).toBe(text.length);
  });

  it('treats a [link](x.md) inside a double-backtick span as inside code', () => {
    // Text: prefix ``[link](x.md)`` suffix
    // The link starts at index 8 (after "prefix ``")
    const text = 'prefix ``[link](x.md)`` suffix';
    const ranges = inlineCodeRanges(text);
    const linkOffset = text.indexOf('[link]');
    const inCode = ranges.some(([s, e]) => linkOffset >= s && linkOffset < e);
    expect(inCode).toBe(true);
  });

  it('the old single-backtick regex would miss the double-backtick span', () => {
    // Demonstrates why the old regex was wrong: /`[^`\n]+`/g on ``a ` b`` would
    // match only the middle portion `` ` `` (leaving the outer backticks unmatched)
    // whereas inlineCodeRanges correctly spans the whole thing.
    const text = '``a ` b``';
    const oldRanges: Array<[number, number]> = [];
    for (const m of text.matchAll(/`[^`\n]+`/g)) {
      oldRanges.push([m.index!, m.index! + m[0].length]);
    }
    const newRanges = inlineCodeRanges(text);
    // Old regex matches the interior `` ` `` sub-span (not the whole span)
    expect(oldRanges[0]).not.toEqual(newRanges[0]);
    // New regex covers the full span
    expect(newRanges[0]).toEqual([0, text.length]);
  });
});
