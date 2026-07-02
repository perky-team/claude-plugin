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

  it('does NOT tag field-selector info when the receiver var is not the method receiver', async () => {
    const { edges, nodes } = await run(SRC);
    // Loose is a plain function; `s` is a parameter, not a method receiver.
    const loose = nodes.find((n) => n.qname === 'events.Loose');
    const call = edges.find((e) => e.kind === 'call' && e.src_id === loose.id && e.dst_name === 'Action');
    expect(call).toBeTruthy();
    expect(call.field_key ?? null).toBeNull();
    // still falls back to the bare method name
    expect(call.dst_name).toBe('Action');
  }, 20000);
});
