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

  // caddyserver/caddy has a bundled JS file with one 157,787-character line.
  // The signature is meant to help a human skim a search hit, not hold a
  // whole minified file — storing it whole is most of that repo's 105.6 MB
  // graph. A short cap with a visible marker keeps the row useful and small.
  it('caps a very long signature line instead of storing it whole', async () => {
    const scm = `(function_declaration name: (identifier) @name) @definition.function`;
    const longLine = `function foo() { ${'x'.repeat(5000)} }`;
    const { nodes } = await extract({
      file: 'a.ts', lang: 'ts', langId: 'typescript', scm, source: longLine,
    });
    const foo = nodes.find((n) => n.name === 'foo');
    expect(foo).toBeTruthy();
    expect(foo.signature.length).toBeLessThanOrEqual(300);
    // A marker at the end, so a truncated signature never reads as complete.
    expect(foo.signature.endsWith('…[truncated]')).toBe(true);
  }, 20000);
});
