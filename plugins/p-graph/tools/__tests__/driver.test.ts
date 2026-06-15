import { describe, it, expect } from 'vitest';
import { extract } from '../lib/parse/driver.mjs';

describe('tags driver', () => {
  it('extracts a function def and a call edge', async () => {
    const scm = `
      (function_declaration name: (identifier) @name) @definition.function
      (call_expression function: (identifier) @reference.call)
    `;
    const { nodes, edges } = await extract({
      file: 'a.ts', lang: 'ts', langId: 'typescript', scm,
      source: 'function foo() { bar(); }',
    });
    const foo = nodes.find((n) => n.name === 'foo');
    expect(foo).toBeTruthy();
    expect(foo.kind).toBe('function');
    expect(foo.qname).toBe('foo');
    const call = edges.find((e) => e.kind === 'call' && e.dst_name === 'bar');
    expect(call).toBeTruthy();
    expect(call.src_id).toBe(foo.id);
  }, 20000);
});
