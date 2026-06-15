import { describe, it, expect } from 'vitest';
import { openStore } from '../lib/destinations/local-sqlite.mjs';

const N = (over = {}) => ({
  id: 'n1', name: 'foo', qname: 'foo', kind: 'function', lang: 'ts',
  file: 'a.ts', start_line: 1, end_line: 3, signature: 'function foo()',
  doc: '', container_id: null, ...over,
});

describe('store write', () => {
  it('replaceFileSymbols inserts nodes and edges, idempotently', () => {
    const s = openStore(':memory:');
    s.upsertFile('a.ts', 'h1', 'ts');
    s.replaceFileSymbols('a.ts', [N()], [{ src_id: 'n1', dst_id: null, dst_name: 'bar', kind: 'call', file: 'a.ts', line: 2 }]);
    expect(s.db.prepare('SELECT count(*) c FROM nodes').get().c).toBe(1);
    expect(s.db.prepare('SELECT count(*) c FROM edges').get().c).toBe(1);
    s.replaceFileSymbols('a.ts', [N()], [{ src_id: 'n1', dst_id: null, dst_name: 'bar', kind: 'call', file: 'a.ts', line: 2 }]);
    expect(s.db.prepare('SELECT count(*) c FROM nodes').get().c).toBe(1);
    expect(s.db.prepare('SELECT count(*) c FROM edges').get().c).toBe(1);
    s.close();
  });
  it('removeFile drops only that file rows', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.ts', [N()], []);
    s.replaceFileSymbols('b.ts', [N({ id: 'n2', file: 'b.ts' })], []);
    s.removeFile('a.ts');
    expect(s.db.prepare('SELECT count(*) c FROM nodes').get().c).toBe(1);
    expect(s.db.prepare("SELECT id FROM nodes").get().id).toBe('n2');
    s.close();
  });
});
