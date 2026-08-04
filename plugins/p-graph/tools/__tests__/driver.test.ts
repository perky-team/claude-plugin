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

  // The cap cuts on a UTF-16 code unit, not a whole character. An astral
  // character (anything outside the Basic Multilingual Plane, like most
  // emoji) is stored as a surrogate pair — two code units. If the cut lands
  // between them, the kept half is a lone high surrogate, which is not valid
  // text on its own: written out as UTF-8 (how SQLite stores TEXT) it turns
  // into the "�" replacement character right before the marker.
  it('does not split a surrogate pair when it cuts the line', async () => {
    const scm = `(function_declaration name: (identifier) @name) @definition.function`;
    const prefix = 'function foo() { ';
    // Placed so the pair's two code units land exactly on the cut boundary
    // (288 = 300 - the 12-code-unit marker) with the current, unfixed cap.
    const before = 'x'.repeat(288 - prefix.length - 1);
    const longLine = `${prefix}${before}\u{1F600}${'x'.repeat(20)} }`;
    const { nodes } = await extract({
      file: 'a.ts', lang: 'ts', langId: 'typescript', scm, source: longLine,
    });
    const foo = nodes.find((n) => n.name === 'foo');
    expect(foo).toBeTruthy();
    expect(foo.signature.length).toBeLessThanOrEqual(300);
    expect(foo.signature.endsWith('…[truncated]')).toBe(true);
    // No lone surrogate anywhere in the kept text — the whole emoji must be
    // either fully in or fully out.
    const kept = foo.signature.slice(0, foo.signature.length - '…[truncated]'.length);
    expect(/[\uD800-\uDFFF]/.test(kept)).toBe(false);
  }, 20000);
});
