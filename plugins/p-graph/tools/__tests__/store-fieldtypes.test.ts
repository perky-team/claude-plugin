import { describe, it, expect } from 'vitest';
import { openStore, SCHEMA_VERSION } from '../lib/destinations/local-sqlite.mjs';

const N = (over = {}) => ({
  id: 'n1', name: 'foo', qname: 'foo', kind: 'function', lang: 'go',
  file: 'a.go', start_line: 1, end_line: 3, signature: '', doc: '', container_id: null, ...over,
});
const FT = (over = {}) => ({ key: 'events.Server.dimpleCore', type: 'core.Core', file: 'a.go', ...over });

describe('store field_types table', () => {
  it('is on the current schema version (bumped for the new table)', () => {
    // The field_types table is a schema change; a stale DB must fully rebuild.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('replaceFileSymbols persists field types and replaces them idempotently', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.go', [N()], [], [FT()]);
    expect(s.db.prepare('SELECT count(*) c FROM field_types').get().c).toBe(1);
    expect(s.db.prepare('SELECT type FROM field_types WHERE key = ?').get('events.Server.dimpleCore').type)
      .toBe('core.Core');
    // re-indexing the same file replaces, not duplicates
    s.replaceFileSymbols('a.go', [N()], [], [FT()]);
    expect(s.db.prepare('SELECT count(*) c FROM field_types').get().c).toBe(1);
    s.close();
  });

  it('removeFile drops only that file field_types', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.go', [N()], [], [FT()]);
    s.replaceFileSymbols('b.go', [N({ id: 'n2', file: 'b.go' })], [], [FT({ key: 'x.Y.z', file: 'b.go' })]);
    s.removeFile('a.go');
    const rows = s.db.prepare('SELECT key FROM field_types').all();
    expect(rows.map((r) => r.key)).toEqual(['x.Y.z']);
    s.close();
  });

  it('clear truncates field_types', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.go', [N()], [], [FT()]);
    s.clear();
    expect(s.db.prepare('SELECT count(*) c FROM field_types').get().c).toBe(0);
    s.close();
  });

  it('replaceFileSymbols without a fieldTypes arg is still valid (non-Go path)', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.ts', [N({ file: 'a.ts', lang: 'ts' })], []);
    expect(s.db.prepare('SELECT count(*) c FROM field_types').get().c).toBe(0);
    s.close();
  });
});
