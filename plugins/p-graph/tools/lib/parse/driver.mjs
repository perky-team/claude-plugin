import { createHash } from 'node:crypto';
import { loadLanguage, parseAndQuery } from './engine.mjs';

const nodeId = (file, qname, kind, ord) =>
  createHash('sha1').update(`${file}|${qname}|${kind}|${ord}`).digest('hex').slice(0, 16);

// Go's predeclared builtin functions (universe block). A plain call to one of
// these belongs to no package, so it must not be package-qualified.
const GO_BUILTINS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag',
  'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
]);

function within(inner, outer) {
  if (inner === outer) return false;
  const startsAfter = outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol);
  const endsBefore = outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol);
  return startsAfter && endsBefore;
}

// Per-file Go context used to qualify symbol names. `pkg` is the declared
// package; `importNames` is the set of identifiers that name an imported
// package (alias when present, else the path's last segment); `hasDotImport`
// flags a `import . "x"` which makes a bare identifier potentially refer to
// another package — so same-package qualification must be skipped for the file.
function goContext(caps) {
  let pkg = null;
  for (const c of caps) if (c.name === 'package') { pkg = c.text; break; }
  const importNames = new Set();
  let hasDotImport = false;
  for (const c of caps) {
    if (c.name !== 'reference.import') continue;
    const nameChild = c.node?.parent?.childForFieldName?.('name');
    if (nameChild) {
      if (nameChild.type === 'dot') { hasDotImport = true; continue; }
      if (nameChild.type === 'blank_identifier') continue;
      if (nameChild.type === 'package_identifier') { importNames.add(nameChild.text); continue; }
    }
    const path = c.text.replace(/^["'`]|["'`]$/g, '');
    const seg = path.split('/').pop();
    if (seg) importNames.add(seg);
  }
  return { pkg, importNames, hasDotImport };
}

// Resolve the qualified call target for a Go reference.call capture. Carries the
// qualifier the call site syntactically provides so the conservative resolver
// can match a qualified qname without guessing; leaves the bare name when the
// qualifier can't be classified as a package (method call on a value/expr) or
// when the call is a builtin / lives in a dot-importing file.
function goCallTarget(c, { pkg, importNames, hasDotImport }) {
  const node = c.node;
  if (node?.type === 'field_identifier') {
    const operand = node.parent?.childForFieldName?.('operand');
    if (operand?.type === 'identifier' && (importNames.has(operand.text) || operand.text === pkg)) {
      return `${operand.text}.${c.text}`;
    }
    return c.text; // receiver type unknown (no type inference) — keep bare name
  }
  if (pkg && !hasDotImport && !GO_BUILTINS.has(c.text)) return `${pkg}.${c.text}`;
  return c.text;
}

export async function extract({ file, lang, langId, scm, source }) {
  const language = await loadLanguage(langId);
  const caps = await parseAndQuery(language, scm, source);
  const goCtx = lang === 'go' ? goContext(caps) : null;

  const defKinds = ['function', 'method', 'class', 'struct', 'interface', 'type', 'enum'];
  const defs = [];
  const defCaps = caps.filter((c) => c.name.startsWith('definition.'));
  const nameCaps = caps.filter((c) => c.name === 'name');
  const recvCaps = caps.filter((c) => c.name === 'receiver');
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
    if (parent) {
      // Nesting already carries any package prefix through the parent's qname.
      def.qname = `${parent.qname}.${def.name}`;
    } else if (goCtx) {
      // Go: package-qualify top-level symbols, receiver-qualify methods, so the
      // resolver can distinguish e.g. filesink.New from udpsink.New. `name`
      // stays bare for search/UX — only qname carries qualification.
      let local = def.name;
      if (def.kind === 'method') {
        const rc = recvCaps.find((r) => within(r, def));
        if (rc) local = `${rc.text}.${local}`;
      }
      def.qname = goCtx.pkg ? `${goCtx.pkg}.${local}` : local;
    } else {
      def.qname = def.name;
    }
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
    const dst_name = goCtx && kind === 'call' ? goCallTarget(c, goCtx) : c.text;
    edges.push({
      src_id: enclosing ? enclosing.id : null,
      dst_id: null, dst_name, kind, file, line: c.startLine,
    });
  }
  return { nodes, edges };
}
