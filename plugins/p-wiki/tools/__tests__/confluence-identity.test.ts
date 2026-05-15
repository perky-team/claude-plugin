import { describe, expect, it } from 'vitest';
import { parsePath, formatPath, createIdentityCache } from '../lib/confluence/identity.mjs';

describe('identity', () => {
  it('parses confluence://concept/foo', () => {
    expect(parsePath('confluence://concept/foo')).toEqual({ type: 'concept', slug: 'foo' });
  });

  it('parses confluence://query/2026-05-15-q', () => {
    expect(parsePath('confluence://query/2026-05-15-q')).toEqual({ type: 'query', slug: '2026-05-15-q' });
  });

  it('throws on malformed input', () => {
    expect(() => parsePath('docs/wiki/x')).toThrow();
    expect(() => parsePath('confluence://')).toThrow();
    expect(() => parsePath('confluence://concept')).toThrow();
  });

  it('formats path from (type, slug)', () => {
    expect(formatPath('concept', 'foo')).toBe('confluence://concept/foo');
  });

  it('cache stores and returns numericId', () => {
    const c = createIdentityCache();
    c.set('concept', 'foo', '12345');
    expect(c.get('concept', 'foo')).toBe('12345');
    expect(c.get('concept', 'bar')).toBeUndefined();
  });
});
