import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

async function run(src, file = 'events/server.go') {
  const cfg = resolveLang(file);
  return extract({ file, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: src });
}

const SRC = `package events
type Server struct {
	dimpleCore *core.Core
	sibling    Helper
	label      string
}
func (s Server) DoAction() { s.dimpleCore.Action() }
func Loose(s *Server) { s.dimpleCore.Action() }
`;

describe('go struct field-type extraction', () => {
  it('emits a package-qualified field-type table keyed by struct qname, pointer stripped', async () => {
    const { fieldTypes } = await run(SRC);
    const byKey = Object.fromEntries(fieldTypes.map((f) => [f.key, f.type]));
    // cross-package pointer field: package qualifier from syntax, '*' stripped
    expect(byKey['events.Server.dimpleCore']).toBe('core.Core');
    // same-package (unqualified) field type -> qualified with the declaring package
    expect(byKey['events.Server.sibling']).toBe('events.Helper');
    // every field row carries its declaring file for incremental cleanup
    expect(fieldTypes.every((f) => f.file === 'events/server.go')).toBe(true);
  }, 20000);

  it('tags a receiver.field.method() call with structured field-selector info', async () => {
    const { edges, nodes } = await run(SRC);
    const doAction = nodes.find((n) => n.qname === 'events.Server.DoAction');
    const call = edges.find((e) => e.kind === 'call' && e.src_id === doAction.id && e.method === 'Action');
    expect(call).toBeTruthy();
    expect(call.field_key).toBe('events.Server.dimpleCore');
    expect(call.method).toBe('Action');
    // bare method name is preserved as the fallback dst_name
    expect(call.dst_name).toBe('Action');
  }, 20000);

  it('does not attribute an embedded type inside an anonymous nested struct to the outer struct', async () => {
    // "inner" is an anonymous struct field of S; base.Base is embedded in THAT
    // anonymous struct, not in S. S itself embeds nothing.
    const src = `package outer
import "x/base"
type S struct {
	inner struct {
		base.Base
	}
}
`;
    const { fieldTypes } = await run(src, 'outer/outer.go');
    expect(fieldTypes.some((f) => f.key === 'outer.S#embed')).toBe(false);
  }, 20000);

  it('does not attribute a named field inside an anonymous nested struct to the outer struct', async () => {
    // Same containment problem, named-field shape: "Name" belongs to the
    // anonymous struct nested in "inner", not to S.
    const src = `package outer
type S struct {
	inner struct {
		Name string
	}
}
`;
    const { fieldTypes } = await run(src, 'outer/outer.go');
    expect(fieldTypes.some((f) => f.key === 'outer.S.Name')).toBe(false);
  }, 20000);

  it('tags field-selector info on a parameter from that parameter\'s declared type', async () => {
    const { edges, nodes } = await run(SRC);
    // Loose is a plain function, so `s` is a parameter rather than a method
    // receiver. Its declared type still says which struct owns `dimpleCore`, so the
    // call gets the same field key a call through the receiver would get.
    const loose = nodes.find((n) => n.qname === 'events.Loose');
    const call = edges.find((e) => e.kind === 'call' && e.src_id === loose.id && e.dst_name === 'Action');
    expect(call).toBeTruthy();
    expect(call.field_key).toBe('events.Server.dimpleCore');
    expect(call.method).toBe('Action');
    // bare method name is still preserved as the fallback dst_name
    expect(call.dst_name).toBe('Action');
  }, 20000);

  it('leaves field-selector info off when the variable\'s type is unknown', async () => {
    // `s` takes its type from a function's return value, which extraction does not
    // read. With no type for `s` there is nothing to say about `s.dimpleCore`, so
    // the call must keep the bare name instead of being pinned to a guess.
    const src = `package events
type Server struct {
	dimpleCore *core.Core
}
func Make() *Server { return nil }
func Loose() {
	s := Make()
	s.dimpleCore.Action()
}
`;
    const { edges, nodes } = await run(src);
    const loose = nodes.find((n) => n.qname === 'events.Loose');
    const call = edges.find((e) => e.kind === 'call' && e.src_id === loose.id && e.dst_name === 'Action');
    expect(call).toBeTruthy();
    expect(call.field_key ?? null).toBeNull();
    expect(call.dst_name).toBe('Action');
  }, 20000);
});
