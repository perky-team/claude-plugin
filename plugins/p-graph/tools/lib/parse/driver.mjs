import { createHash } from 'node:crypto';
import { loadLanguage, parseAndQuery } from './engine.mjs';

const nodeId = (file, qname, kind, ord) =>
  createHash('sha1').update(`${file}|${qname}|${kind}|${ord}`).digest('hex').slice(0, 16);

function within(inner, outer) {
  if (inner === outer) return false;
  const startsAfter = outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol);
  const endsBefore = outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol);
  return startsAfter && endsBefore;
}

export async function extract({ file, lang, langId, scm, source }) {
  const language = await loadLanguage(langId);
  const caps = await parseAndQuery(language, scm, source);

  const defKinds = ['function', 'method', 'class', 'struct', 'interface', 'type', 'enum'];
  const defs = [];
  const defCaps = caps.filter((c) => c.name.startsWith('definition.'));
  const nameCaps = caps.filter((c) => c.name === 'name');
  for (const d of defCaps) {
    const kind = d.name.split('.')[1];
    if (!defKinds.includes(kind)) continue;
    const nameCap = nameCaps
      .filter((n) => within(n, d))
      .sort((a, b) => (a.startLine - d.startLine) - (b.startLine - d.startLine))[0];
    defs.push({
      kind, name: nameCap?.text ?? '(anon)',
      startLine: d.startLine, endLine: d.endLine,
      startCol: d.startCol, endCol: d.endCol,
      signature: source.split('\n')[d.startLine - 1]?.trim() ?? '',
    });
  }

  defs.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  const ordSeen = new Map();
  for (const def of defs) {
    const parent = defs.filter((p) => within(def, p)).sort((a, b) => b.startLine - a.startLine)[0];
    def.qname = parent ? `${parent.qname}.${def.name}` : def.name;
    const key = `${def.qname}|${def.kind}`;
    const ord = ordSeen.get(key) ?? 0; ordSeen.set(key, ord + 1);
    def.id = nodeId(file, def.qname, def.kind, ord);
    def.container_id = parent ? parent.id : null;
  }

  const nodes = defs.map((d) => ({
    id: d.id, name: d.name, qname: d.qname, kind: d.kind, lang,
    file, start_line: d.startLine, end_line: d.endLine,
    signature: d.signature, doc: '', container_id: d.container_id,
  }));

  const refMap = { 'reference.call': 'call', 'reference.import': 'import', 'reference.include': 'include' };
  const edges = [];
  for (const c of caps) {
    const kind = refMap[c.name];
    if (!kind) continue;
    const enclosing = defs.filter((d) => within(c, d)).sort((a, b) => b.startLine - a.startLine)[0];
    edges.push({
      src_id: enclosing ? enclosing.id : null,
      dst_id: null, dst_name: c.text, kind, file, line: c.startLine,
    });
  }
  return { nodes, edges };
}
