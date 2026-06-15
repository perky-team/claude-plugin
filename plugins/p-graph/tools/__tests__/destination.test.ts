import { describe, it, expect } from 'vitest';
import { resolveDestination } from '../lib/destination.mjs';

describe('destination resolver', () => {
  it('returns a local-sqlite store for destination=local', () => {
    const store = resolveDestination({ destination: 'local' }, ':memory:');
    expect(typeof store.search).toBe('function');
    store.close();
  });
  it('throws on unknown destination', () => {
    expect(() => resolveDestination({ destination: 'mars' }, ':memory:')).toThrow(/unknown destination/);
  });
});
