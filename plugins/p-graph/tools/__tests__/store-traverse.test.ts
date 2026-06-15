import { describe, it, expect } from 'vitest';
import { openStore } from '../lib/destinations/local-sqlite.mjs';

function node(id) { return { id, name: id, qname: id, kind: 'function', lang: 'ts', file: 'a.ts', start_line: 1, end_line: 1, signature: id, doc: '', container_id: null }; }

describe('store traverse', () => {
  it('impact returns transitive callers and terminates on cycles', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.ts', [node('a'), node('b'), node('c')], [
      { src_id: 'a', dst_id: 'b', dst_name: 'b', kind: 'call', file: 'a.ts', line: 1 },
      { src_id: 'b', dst_id: 'c', dst_name: 'c', kind: 'call', file: 'a.ts', line: 1 },
      { src_id: 'c', dst_id: 'a', dst_name: 'a', kind: 'call', file: 'a.ts', line: 1 },
    ]);
    const imp = s.impact('c').map((x) => x.qname).sort();
    expect(imp).toContain('b');
    expect(imp).toContain('a');
    s.close();
  });
  it('trace finds a path from a to c', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.ts', [node('a'), node('b'), node('c')], [
      { src_id: 'a', dst_id: 'b', dst_name: 'b', kind: 'call', file: 'a.ts', line: 1 },
      { src_id: 'b', dst_id: 'c', dst_name: 'c', kind: 'call', file: 'a.ts', line: 1 },
    ]);
    expect(s.trace('a', 'c')).toEqual(['a', 'b', 'c']);
    expect(s.trace('c', 'a')).toBeNull();
    s.close();
  });
  it('resolvePending links edges once target appears', () => {
    const s = openStore(':memory:');
    s.replaceFileSymbols('a.ts', [node('a')], [
      { src_id: 'a', dst_id: null, dst_name: 'b', kind: 'call', file: 'a.ts', line: 1 },
    ]);
    s.replaceFileSymbols('b.ts', [node('b')], []);
    s.resolvePending();
    expect(s.callees('a').map((x) => x.qname)).toContain('b');
    s.close();
  });
  it('resolvePending re-resolves a dangling dst_id to a same-named replacement', () => {
    const s = openStore(':memory:');
    // a -> b, with b defined in b.ts
    s.replaceFileSymbols('a.ts', [node('a')], [
      { src_id: 'a', dst_id: null, dst_name: 'b', kind: 'call', file: 'a.ts', line: 1 },
    ]);
    s.replaceFileSymbols('b.ts', [{ ...node('b'), id: 'b_old' }], []);
    s.resolvePending();
    expect(s.callees('a').map((x) => x.qname)).toContain('b');

    // b.ts removed and b reappears in c.ts with a different node id.
    s.removeFile('b.ts');
    s.replaceFileSymbols('c.ts', [{ ...node('b'), id: 'b_new', file: 'c.ts' }], []);
    s.resolvePending();
    // The edge's stale dst_id (b_old) must be re-pointed at b_new.
    expect(s.callees('a').map((x) => x.qname)).toContain('b');
    s.close();
  });
});
