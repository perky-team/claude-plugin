import { describe, it, expect } from 'vitest';
import { extract } from '../lib/parse/driver.mjs';
import { resolveLang } from '../lib/parse/index.mjs';

// The one call edge in `source`, with its source symbol named rather than a
// node id — which is what the tie-break below is actually about.
async function callFrom(file, source) {
  const cfg = resolveLang(file);
  const { nodes, edges } = await extract({
    file, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const call = edges.find((e) => e.kind === 'call');
  return { src: call && byId.get(call.src_id)?.qname, dst_name: call?.dst_name };
}

describe('driver containment is column-aware', () => {
  it('two arrow functions on one line are siblings, not nested, no undefined qname', async () => {
    const scm = `(lexical_declaration (variable_declarator name: (identifier) @name (arrow_function))) @definition.function`;
    const { nodes } = await extract({ file: 'x.js', lang: 'js', langId: 'javascript', scm, source: 'const a = () => {}; const b = () => {};' });
    const qnames = nodes.map((n) => n.qname).sort();
    expect(qnames).toEqual(['a', 'b']);
    expect(qnames.some((q) => q.includes('undefined'))).toBe(false);
  }, 20000);

  // Which definition a call sits inside was picked by start LINE alone, so two
  // definitions opened on one line left the choice to capture order — and that
  // order is outermost first. The parent pick already breaks the tie on the
  // column; the call-site pick, the Go binding owner and the struct-field owner
  // did not.
  //
  // The wrong src_id is old news. What makes it matter now is that C++ call
  // targets are recorded from the enclosing definition's scope, so a one-line
  // shape corrupts the recorded TARGET too — a wrong answer, printed plainly.
  it('a call inside nested one-line C++ namespaces belongs to the inner function', async () => {
    const { src, dst_name } = await callFrom(
      's.cpp', 'namespace a { namespace b { void g() {} void f() { g(); } } }\n');
    expect(src).toBe('a.b.f');
    // The target too: with the outer namespace as the scope, the call was
    // recorded as a.g, which names nothing, so the real a.b.g went missing.
    expect(dst_name).toBe('a.b.g');
  }, 20000);

  it('a call inside a one-line C++ struct belongs to the method, not the struct', async () => {
    const { src } = await callFrom(
      's.cpp', 'int helper() { return 1; }\nstruct S { int f() { return helper(); } };\n');
    expect(src).toBe('S.f');
  }, 20000);

  // Not only C++: the same tie decides which TS symbol a call is attributed to,
  // and a one-line class is ordinary formatting in generated or minified code.
  it('a call inside a one-line TS class belongs to the method, not the class', async () => {
    const { src } = await callFrom(
      'a.ts', 'function sink() {}\nclass Middle { hop() { sink(); } }\n');
    expect(src).toBe('Middle.hop');
  }, 20000);
});
