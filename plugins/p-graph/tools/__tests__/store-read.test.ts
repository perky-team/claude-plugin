import { describe, it, expect, beforeEach } from 'vitest';
import { openStore } from '../lib/destinations/local-sqlite.mjs';

function seed(s) {
  s.upsertFile('a.ts', 'h', 'ts');
  s.replaceFileSymbols('a.ts', [
    { id: 'foo', name: 'foo', qname: 'foo', kind: 'function', lang: 'ts', file: 'a.ts', start_line: 1, end_line: 2, signature: 'function foo()', doc: '', container_id: null },
    { id: 'bar', name: 'bar', qname: 'bar', kind: 'function', lang: 'ts', file: 'a.ts', start_line: 4, end_line: 6, signature: 'function bar()', doc: '', container_id: null },
  ], [
    { src_id: 'foo', dst_id: 'bar', dst_name: 'bar', kind: 'call', file: 'a.ts', line: 1 },
  ]);
}

describe('store read', () => {
  let s;
  beforeEach(() => { s = openStore(':memory:'); seed(s); });
  it('search finds by name', () => {
    expect(s.search('foo', {}).map((x) => x.qname)).toContain('foo');
  });
  it('node returns one symbol by id or qname', () => {
    expect(s.node('foo').kind).toBe('function');
    expect(s.node('bar').name).toBe('bar');
  });
  it('callers/callees resolve via edges', () => {
    expect(s.callers('bar').map((x) => x.qname)).toContain('foo');
    expect(s.callees('foo').map((x) => x.qname)).toContain('bar');
  });
  it('files lists per-file symbol counts', () => {
    expect(s.files('a.ts')[0]).toMatchObject({ path: 'a.ts', symbols: 2 });
  });
  it('status returns counts', () => {
    expect(s.status()).toMatchObject({ nodes: 2, edges: 1, files: 1 });
  });
});
