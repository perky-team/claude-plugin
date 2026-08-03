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

// Go's predeclared type names. `float64(n)` parses as a call, but it converts a
// value — it never targets a repo symbol, so it must not be resolved or reported
// as a gap.
const GO_PREDECLARED_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error',
  'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune',
  'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
]);

// The last segment of a dotted target name. A call site records whatever the
// source wrote — `bp.GetBuffer` under an import alias, `api.W.helper` for an own
// receiver — so the bare segment is the only part that is stable across
// qualifiers, and it is what the gap report has to match on.
const bareSegment = (name) =>
  typeof name === 'string' && name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;

function within(inner, outer) {
  if (inner === outer) return false;
  const startsAfter = outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol);
  const endsBefore = outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol);
  return startsAfter && endsBefore;
}

// Per-file Go context used to qualify symbol names. `pkg` is the declared
// package. `importPkgs` maps the identifier a call site writes to the imported
// package's real name — they differ under an alias (`bp "x/util/bufferpool"`
// writes `bp` but every symbol's qname says `bufferpool`), so the alias has to be
// translated or the call can never match a qname. `hasDotImport` flags a
// `import . "x"`, which makes a bare identifier possibly belong to another
// package, so same-package qualification must be skipped for the whole file.
function goContext(caps) {
  let pkg = null;
  for (const c of caps) if (c.name === 'package') { pkg = c.text; break; }
  const importPkgs = new Map();
  let hasDotImport = false;
  for (const c of caps) {
    if (c.name !== 'reference.import') continue;
    const path = c.text.replace(/^["'`]|["'`]$/g, '');
    // A module path may end in a major-version segment (`…/caddy/v2`). The
    // package is named by the segment before it, so taking the last segment
    // registers a package called "v2" — after which no call through that import
    // resolves, and the gap report's reachability check can never match either.
    const parts = path.split('/').filter(Boolean);
    let seg = parts.pop();
    if (/^v[0-9]+$/.test(seg) && parts.length) seg = parts.pop();
    const nameChild = c.node?.parent?.childForFieldName?.('name');
    if (nameChild) {
      if (nameChild.type === 'dot') { hasDotImport = true; continue; }
      if (nameChild.type === 'blank_identifier') continue;
      if (nameChild.type === 'package_identifier') {
        importPkgs.set(nameChild.text, seg || nameChild.text);
        continue;
      }
    }
    if (seg) importPkgs.set(seg, seg);
  }
  return { pkg, importPkgs, hasDotImport };
}

// Render a Go field type node to a package-qualified type name, stripping any
// leading '*' (pointer). `core.Core` -> "core.Core" (qualifier from syntax);
// a bare `Helper` -> "<pkg>.Helper" (same package). Returns null for shapes we
// don't resolve method receivers through (slices, maps, funcs, interfaces,
// channels, embedded fields) — those keep the bare-name fallback.
function goFieldTypeName(typeNode, pkg) {
  let n = typeNode;
  while (n && n.type === 'pointer_type') n = n.namedChild(0);
  if (!n) return null;
  if (n.type === 'qualified_type') {
    const p = n.childForFieldName?.('package');
    const nm = n.childForFieldName?.('name');
    return p && nm ? `${p.text}.${nm.text}` : null;
  }
  if (n.type === 'type_identifier') return pkg ? `${pkg}.${n.text}` : n.text;
  return null;
}

// The type node a Go initializer names, for the shapes that write the type right
// there: `T{}`, `&T{}` and `new(T)`. Anything else — a function call, a
// conversion, a channel receive — needs real type inference, so this returns null
// and the variable stays untyped.
function goInitTypeNode(expr) {
  let n = expr;
  // `&T{}`. A composite literal is the only operand shape that names a type, so
  // there is no need to check the operator.
  if (n?.type === 'unary_expression') n = n.childForFieldName?.('operand');
  if (n?.type === 'composite_literal') return n.childForFieldName?.('type') ?? null;
  if (n?.type === 'call_expression' && n.childForFieldName?.('function')?.text === 'new') {
    return n.childForFieldName?.('arguments')?.namedChild(0) ?? null;
  }
  return null;
}

// The names a Go declaration introduces, each paired with the type node that
// gives its type. Pairing runs through the node's own fields, never by position:
// `a, b *store.Postgres` has two names and one type and both must get a row, and
// a nested declaration would break any positional guess.
function goVarDeclNames(decl) {
  const out = [];
  // A short declaration is the one shape where each name has its own value, and
  // Go itself pairs `a, b := x, y` by index — so index pairing is the language
  // rule here, not a guess. `a, b := f()` has one value for two names, so there is
  // no per-name type to read. The names still come back with no type: they ARE
  // declared here, and saying so is what stops a package-level namesake from
  // answering a call on them.
  if (decl.type === 'short_var_declaration') {
    const left = decl.childForFieldName?.('left');
    const right = decl.childForFieldName?.('right');
    if (!left) return out;
    const paired = right && left.namedChildCount === right.namedChildCount;
    for (let i = 0; i < left.namedChildCount; i++) {
      const name = left.namedChild(i);
      if (name.type !== 'identifier') continue;
      out.push({ name: name.text, typeNode: paired ? goInitTypeNode(right.namedChild(i)) : null });
    }
    return out;
  }
  // `var_spec` marks its comma tokens with the `name` field as well, so filter on
  // the node type — otherwise a row keyed on "," gets recorded.
  const names = [];
  for (let i = 0; i < decl.childCount; i++) {
    if (decl.fieldNameForChild(i) !== 'name') continue;
    const child = decl.child(i);
    if (child.type === 'identifier') names.push(child.text);
  }
  const declared = decl.childForFieldName?.('type');
  // `var x = &T{}` states the type in the initializer instead. One value per name,
  // same rule as a short declaration.
  const value = declared ? null : decl.childForFieldName?.('value');
  const perName = value && value.namedChildCount === names.length;
  for (let i = 0; i < names.length; i++) {
    out.push({ name: names[i], typeNode: declared ?? (perName ? goInitTypeNode(value.namedChild(i)) : null) });
  }
  return out;
}

// Resolve the qualified call target for a Go reference.call capture. Carries the
// qualifier the call site syntactically provides so the conservative resolver
// can match a qualified qname without guessing; leaves the bare name when the
// qualifier can't be classified as a package (method call on a value/expr) or
// when the call is a builtin / lives in a dot-importing file.
//
// Two shapes return structured info instead of a plain name, for the caller to
// bind against the enclosing method's receiver:
//   `recvVar.field.Method()` -> {bare, recvVar, field, method} — the field's
//      static type is looked up in the field-type table at build time.
//   `recvVar.Method()`       -> {bare, recvVar, method} — no field, so the
//      receiver's own type names the target directly.
// `bare` stays as the fallback dst_name when neither can be bound.
//
// `namesAVar` answers whether an identifier names a variable in scope rather than
// a package. It is asked BEFORE the import table on purpose: a variable shadows a
// package of the same name, and reading it as the package qualifies the call to
// the wrong package. hugo does this — a local `config` hides the imported package
// `config`, so `config.ToKeywords()` was recorded as a call into that package.
function goCallTarget(c, { pkg, importPkgs, hasDotImport }, namesAVar = () => false) {
  const node = c.node;
  if (node?.type === 'field_identifier') {
    const operand = node.parent?.childForFieldName?.('operand');
    if (operand?.type === 'identifier') {
      if (!namesAVar(operand.text)) {
        // An imported package, under whatever name this file calls it.
        const importedAs = importPkgs.get(operand.text);
        if (importedAs) return `${importedAs}.${c.text}`;
        if (operand.text === pkg) return `${pkg}.${c.text}`;
      }
      return { bare: c.text, recvVar: operand.text, method: c.text };
    }
    if (operand?.type === 'selector_expression') {
      const innerRecv = operand.childForFieldName?.('operand');
      const innerField = operand.childForFieldName?.('field');
      if (innerRecv?.type === 'identifier' && innerField?.type === 'field_identifier') {
        return { bare: c.text, recvVar: innerRecv.text, field: innerField.text, method: c.text };
      }
    }
    return c.text; // receiver is an expression, not a name — keep bare name
  }
  if (pkg && !hasDotImport && !GO_BUILTINS.has(c.text)) return `${pkg}.${c.text}`;
  return c.text;
}

// Kinds that own methods, so a `this`/`self` call inside one of their methods
// can be bound to them.
const OWNER_KINDS = new Set(['class', 'struct', 'interface']);

// The type a `this.m()` / `this->m()` / `self.m()` call belongs to, for languages
// where qname comes from lexical nesting (TS/JS, Python, C++). The owning type is
// the enclosing method's container, so no type inference is needed — but a bare
// `m` would collide with every same-named method in the repo and get dropped as
// ambiguous. Returns the owner def, or null when the receiver isn't the enclosing
// object (a plain variable, or a `this` inside a nested function whose container
// is not a type).
function selfCallOwner(c, lang, defs, enclosing) {
  if (!enclosing?.container_id) return null;
  const parent = c.node?.parent;
  // TS/JS member_expression uses `object`; C++ field_expression uses `argument`;
  // Python attribute uses `object`.
  const recv = parent?.childForFieldName?.('object') ?? parent?.childForFieldName?.('argument');
  if (!recv) return null;
  // Only Python names the receiver with an ordinary identifier, so restrict the
  // by-name check to it: a TS variable called `self` must not be mistaken for it.
  const isSelf = lang === 'py' ? (recv.text === 'self' || recv.text === 'cls') : recv.type === 'this';
  if (!isSelf) return null;
  const owner = defs.find((d) => d.id === enclosing.container_id);
  return owner && OWNER_KINDS.has(owner.kind) ? owner : null;
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
  const recvNameCaps = caps.filter((c) => c.name === 'receiver.name');
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
      node: d.node, // kept for containment checks below; never copied into `nodes`
    });
  }

  // Collapse defs that occupy the exact same span into one, keeping the most
  // specific kind. A grouped Go `type_spec` matches both its shape-specific rule
  // (struct/interface) and the generic `@definition.type` rule, so the same node
  // is captured twice; without this the two identical-span defs would look like
  // parent/child to `within()` and produce a bogus `X.X` qname (and an undefined
  // container_id that then fails the DB insert, dropping the whole file).
  const KIND_SPECIFICITY = { struct: 3, interface: 3, enum: 3, class: 3, type: 2, function: 1, method: 1 };
  const bySpan = new Map();
  for (const d of defs) {
    const span = `${d.startLine}:${d.startCol}:${d.endLine}:${d.endCol}`;
    const prev = bySpan.get(span);
    if (!prev || (KIND_SPECIFICITY[d.kind] ?? 0) > (KIND_SPECIFICITY[prev.kind] ?? 0)) bySpan.set(span, d);
  }
  const dedupedDefs = [...bySpan.values()];
  defs.length = 0;
  defs.push(...dedupedDefs);

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
        if (rc) {
          local = `${rc.text}.${local}`;
          // Package-qualified receiver type, e.g. "events.Server". Used to build
          // the field-type table key when a call goes through the receiver.
          def.recvType = goCtx.pkg ? `${goCtx.pkg}.${rc.text}` : rc.text;
        }
        // Receiver variable name (the "s" in `func (s Server) ...`), so a call
        // `s.field.Method()` can be bound to this receiver's type — and only this.
        const rn = recvNameCaps.find((r) => within(r, def));
        if (rn) def.recvVar = rn.text;
      }
      def.qname = goCtx.pkg ? `${goCtx.pkg}.${local}` : local;
    } else {
      def.qname = def.name;
    }
    const key = `${def.qname}|${def.kind}`;
    const ord = ordSeen.get(key) ?? 0; ordSeen.set(key, ord + 1);
    def.id = nodeId(file, def.qname, def.kind, ord);
    // `?? null`: never bind `undefined` to the DB. Parents always precede their
    // children after the span-dedup + sort above, so parent.id is set here; the
    // guard is defense-in-depth so a future capture-shape change can't resurface
    // the whole-file-drop that an undefined container_id caused.
    def.container_id = parent?.id ?? null;
  }

  const nodes = defs.map((d) => ({
    id: d.id, name: d.name, qname: d.qname, kind: d.kind, lang,
    file, start_line: d.startLine, end_line: d.endLine,
    signature: d.signature, doc: '', container_id: d.container_id,
  }));

  // Struct-field-type table: <struct qname>.<field> -> package-qualified field
  // type ('*' stripped). Built at extraction (local syntax), resolved at build
  // time (cross-package). Only emitted for Go, where receiver typing applies.
  const fieldTypes = [];
  if (goCtx) {
    const fieldDeclCaps = caps.filter((c) => c.name === 'field.decl');
    for (const fd of fieldDeclCaps) {
      const structDef = defs
        .filter((d) => d.kind === 'struct' && within(fd, d))
        .sort((a, b) => b.startLine - a.startLine)[0];
      if (!structDef) continue;
      // `within()` only compares line/col spans, so a field nested inside an
      // ANONYMOUS struct type (`inner struct { base.Base }`) still looks like
      // it sits "within" the named outer struct — there is no separate def for
      // the anonymous one. Confirm the field's immediate struct_type ancestor
      // really is the outer struct's own, or a field of the inner anonymous
      // struct gets attributed to the outer struct — inventing an embed (or a
      // field type) that struct never has.
      let structTypeAncestor = fd.node?.parent;
      while (structTypeAncestor && structTypeAncestor.type !== 'struct_type') {
        structTypeAncestor = structTypeAncestor.parent;
      }
      // Two node objects can point at the same tree position without being
      // the same JS reference (each query match rewraps nodes), so compare
      // with the tree-sitter Node.equals identity check, not `!==`.
      const ownStructType = structDef.node?.childForFieldName?.('type');
      if (!structTypeAncestor?.equals(ownStructType)) continue;
      const node = fd.node;
      const typeName = goFieldTypeName(node?.childForFieldName?.('type'), goCtx.pkg);
      if (!typeName) continue; // embedded field or a type shape we don't resolve through
      let hasNamedField = false;
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) !== 'name') continue;
        hasNamedField = true;
        fieldTypes.push({ key: `${structDef.qname}.${node.child(i).text}`, type: typeName, file });
      }
      // An embedded field has a type and no name. Record it under a synthetic
      // "#embed" key: knowing what a struct embeds is what lets the resolver tell
      // a real promoted method (the struct embeds a repo type) from a call on an
      // external one (`struct{ sync.Mutex }` and then `l.Lock()`).
      if (!hasNamedField) fieldTypes.push({ key: `${structDef.qname}#embed`, type: typeName, file });
    }
  }

  // Parameter and variable types, keyed "<enclosing def qname>#var:<name>", or
  // "<pkg>#pkgvar:<name>" for a package-level var. They go in the same table as
  // struct fields so the same resolver passes and the same guards apply, with no
  // new resolver code: Pass F resolves "<type>.<method>", and Pass B refuses the
  // bare-name fallback when the type is known but is not a repo type.
  // `goFieldTypeName` returns null for shapes we do not resolve through (slice,
  // map, func, inline interface), so an unnameable type records nothing and that
  // call keeps today's behaviour. Two rows for one key mean the name holds more
  // than one type, and Pass F's "exactly one known type" guard refuses it. Neither
  // key can collide with a field key — `#` is not legal in a Go identifier.
  //
  // `declaredIn` also records names we could NOT type. A call on such a name must
  // stay a guess, and knowing the name is taken is what stops it from being
  // answered with a package-level type that happens to share it.
  const pkgVarKey = (name) => `${goCtx.pkg}#pkgvar:${name}`;
  const declaredIn = new Map(); // def qname -> Set of names declared inside it
  const pkgVarNames = new Set(); // package-level names this FILE declares
  // key -> the one type recorded for it in THIS file, or null when this file
  // recorded two. Used for `x.f.M()`, where the field key needs the type that owns
  // the field spelled out at extraction time.
  const varTypes = new Map();
  if (goCtx) {
    const ownerOf = (cap) =>
      defs.filter((d) => within(cap, d)).sort((a, b) => b.startLine - a.startLine)[0];
    const claim = (owner, name) => {
      if (!owner) { pkgVarNames.add(name); return; }
      if (!declaredIn.has(owner.qname)) declaredIn.set(owner.qname, new Set());
      declaredIn.get(owner.qname).add(name);
    };
    for (const vd of caps.filter((c) => c.name === 'var.decl')) {
      const owner = ownerOf(vd);
      for (const { name, typeNode } of goVarDeclNames(vd.node)) {
        claim(owner, name);
        const typeName = typeNode ? goFieldTypeName(typeNode, goCtx.pkg) : null;
        if (!typeName) continue;
        // A package-level var has no definition to key on, so the package names it
        // — which is the scope Go gives it. Keyed that way, a file that only USES
        // it resolves through the file that declares it, the same cross-file lookup
        // a struct field type already relies on.
        if (!owner && !goCtx.pkg) continue;
        const key = owner ? `${owner.qname}#var:${name}` : pkgVarKey(name);
        fieldTypes.push({ key, type: typeName, file });
        // A second, different type for one name means this file cannot say what the
        // name holds, so `x.f.M()` must not be pinned to either.
        varTypes.set(key, varTypes.has(key) && varTypes.get(key) !== typeName ? null : typeName);
      }
    }
    for (const vl of caps.filter((c) => c.name === 'var.local')) claim(ownerOf(vl), vl.text);
  }

  const refMap = { 'reference.call': 'call', 'reference.import': 'import', 'reference.include': 'include' };
  const edges = [];
  for (const c of caps) {
    const kind = refMap[c.name];
    if (!kind) continue;
    const enclosing = defs.filter((d) => within(c, d)).sort((a, b) => b.startLine - a.startLine)[0];
    let dst_name, field_key = null, method = null;
    const isLocalName = (name) => Boolean(enclosing && declaredIn.get(enclosing.qname)?.has(name));
    // An identifier names a variable, not a package, when this definition declares
    // it or this file declares it at package level. Both facts are file-local, and
    // that is exactly right: an import is file-scoped in Go, so a package-level
    // name declared in ANOTHER file cannot shadow this file's import.
    const namesAVar = (name) => isLocalName(name) || pkgVarNames.has(name);
    // The key to look a call on a plain identifier up under. Go resolves the
    // innermost scope first, so a name this definition declares wins over a
    // package-level one that shares it.
    const varKeyFor = (name) => {
      if (!isLocalName(name) && goCtx?.pkg) return pkgVarKey(name);
      return enclosing ? `${enclosing.qname}#var:${name}` : null;
    };
    const target = goCtx && kind === 'call' ? goCallTarget(c, goCtx, namesAVar) : c.text;
    if (target && typeof target === 'object') {
      dst_name = target.bare; // bare method name — the fallback if we can't infer the type
      // Bind only when the call's receiver var IS the enclosing method's own
      // receiver and that receiver's type is known. Anything else (plain
      // function, param, local var) keeps the bare-name fallback — no guessing.
      const onOwnReceiver = enclosing?.kind === 'method' && enclosing.recvVar &&
        enclosing.recvVar === target.recvVar && enclosing.recvType;
      if (onOwnReceiver && target.field) {
        field_key = `${enclosing.recvType}.${target.field}`;
        method = target.method;
      } else if (onOwnReceiver) {
        // `s.M()` — the receiver's own type names the target exactly. `method`
        // keeps the bare name so a promoted method of an embedded struct (no
        // `<recvType>.M` node exists) still falls back instead of vanishing.
        dst_name = `${enclosing.recvType}.${target.method}`;
        method = target.method;
      } else if (target.field) {
        // `x.f.M()` where `x` is a variable this file typed. The field key is the
        // same one the own-receiver branch above builds, so the resolver needs
        // nothing new — we only have to name the type that owns the field. Without
        // a single known type for `x` there is nothing to key on, so the bare name
        // keeps falling back, as before.
        const recvType = varTypes.get(varKeyFor(target.recvVar));
        if (recvType) {
          field_key = `${recvType}.${target.field}`;
          method = target.method;
        }
      } else if (target.recvVar) {
        // `x.M()` on a parameter or a variable. Keyed exactly like a field call,
        // so Pass F resolves it when we recorded one type for `x`, and Pass B
        // refuses the bare-name fallback when that type is not a repo type. With
        // no row for the key nothing changes: the bare name still falls back,
        // which is right for a variable whose type we cannot read.
        field_key = varKeyFor(target.recvVar);
        if (field_key) method = target.method;
      }
    } else {
      dst_name = target;
      // Same idea for lexically-nested languages: `this.m()` / `self.m()` belongs
      // to the enclosing type, so name it instead of leaving an ambiguous bare `m`.
      if (kind === 'call' && !goCtx) {
        const owner = selfCallOwner(c, lang, defs, enclosing);
        if (owner) { dst_name = `${owner.qname}.${c.text}`; method = c.text; }
      }
    }
    // A plain-identifier call to a builtin or a predeclared type names nothing in
    // the repo. Marked here, once, so neither the resolver nor the gap report has
    // to keep a Go word list in SQL.
    const external = lang === 'go' && c.node?.type !== 'field_identifier' &&
      (GO_BUILTINS.has(c.text) || GO_PREDECLARED_TYPES.has(c.text)) ? 1 : 0;
    edges.push({
      src_id: enclosing ? enclosing.id : null,
      dst_id: null, dst_name, dst_bare: bareSegment(dst_name), lang, external,
      field_key, method, kind, file, line: c.startLine,
    });
  }
  return { nodes, edges, fieldTypes };
}
