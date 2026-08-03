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
  // Schema 7 adds these two columns for later tasks (guess: Task 5, member:
  // Task 6) in the same bump that changes qnames — so a graph that already
  // migrated to 7 never opens with one of them missing.
  it('gives edges a guess and a member column, both defaulting to 0', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('f.go', [], [{
      src_id: 'a', dst_id: null, dst_name: 'x', kind: 'call', file: 'f.go', line: 1,
    }]);
    const row = s.db.prepare('SELECT guess, member FROM edges LIMIT 1').get();
    expect(row).toEqual({ guess: 0, member: 0 });
    s.close();
  });
});
