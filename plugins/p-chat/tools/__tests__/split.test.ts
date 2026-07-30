import { describe, expect, it } from 'vitest';
import { splitMessage, TELEGRAM_MAX } from '../lib/split.mjs';

describe('splitMessage', () => {
  it('returns short text as a single chunk and [] for empty', () => {
    expect(splitMessage('hi')).toEqual(['hi']);
    expect(splitMessage('')).toEqual([]);
  });

  it('exactly 4096 chars stays one chunk', () => {
    expect(splitMessage('x'.repeat(TELEGRAM_MAX))).toHaveLength(1);
  });

  it('splits oversized text into <= 4096 chunks that reassemble losslessly (hard cut, no newlines)', () => {
    const text = 'x'.repeat(10_000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers a newline boundary near the limit', () => {
    const text = 'a'.repeat(4000) + '\n' + 'b'.repeat(500);
    const chunks = splitMessage(text);
    expect(chunks).toEqual(['a'.repeat(4000), 'b'.repeat(500)]);
  });

  it('never splits a surrogate pair', () => {
    const text = '💩'.repeat(3000); // 6000 UTF-16 units
    const chunks = splitMessage(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
      // A lone surrogate at a boundary would make the chunk ill-formed.
      expect(c).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
    expect(chunks.join('')).toBe(text);
  });
});
