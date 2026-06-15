import { describe, it, expect } from 'vitest';
import { openStore, SCHEMA_VERSION } from '../lib/destinations/local-sqlite.mjs';

describe('store open', () => {
  it('opens in-memory and records schema version + meta', () => {
    const s = openStore(':memory:');
    expect(s.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    s.setMeta('indexed_sha', 'abc123');
    expect(s.getMeta('indexed_sha')).toBe('abc123');
    s.close();
  });
  it('reports hasFts boolean', () => {
    const s = openStore(':memory:');
    expect(typeof s.hasFts).toBe('boolean');
    s.close();
  });
});
