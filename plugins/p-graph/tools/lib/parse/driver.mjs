import { createHash } from 'node:crypto';
import { loadLanguage, parseAndQuery } from './engine.mjs';
import { OWNER_KINDS } from '../owner-kinds.mjs';

const nodeId = (file, qname, kind, ord) =>
  createHash('sha1').update(`${file}|${qname}|${kind}|${ord}`).digest('hex').slice(0, 16);

// `signature` is a hint for a human skimming a search hit, not a copy of the
// source. Without a cap, one bundled/minified file with a single huge line
// (caddyserver/caddy ships one 157,787 characters long) turns into a giant row
// that dominates the whole graph's size — that one file alone was most of a
// 105.6 MB database. The marker at the end says plainly that the line was cut,
// so a truncated signature is never mistaken for a complete one.
const SIGNATURE_CAP = 300;
const TRUNCATION_MARKER = '…[truncated]';
const capSignature = (line) => {
  if (line.length <= SIGNATURE_CAP) return line;
  let cut = SIGNATURE_CAP - TRUNCATION_MARKER.length;
  // A code-unit cut can land inside a surrogate pair (an astral character,
  // like most emoji, is stored as two UTF-16 code units). If the kept half
  // ends on a high surrogate, its partner just got cut off, so back up one
  // more unit — the whole character goes, not half of it.
  const lastCode = line.charCodeAt(cut - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) cut -= 1;
  return line.slice(0, cut) + TRUNCATION_MARKER;
};

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

// "Position a is at or before position b", lines 1-based, columns 0-based.
const posLE = (aLine, aCol, bLine, bCol) => aLine < bLine || (aLine === bLine && aCol <= bCol);

// Sorts a list of definitions innermost first: the one that opens last and
// closes first encloses the others. Every "which definition is this inside?"
// pick uses it — the parent of a definition, the caller of a call, the owner of
// a Go binding, the struct a field belongs to.
//
// The columns have to break the line ties, or the choice is left to capture
// order, which is outermost first. `namespace a { namespace b { void g() {} void
// f() { g(); } } }` on one line then reads the call as made by `a`, and records
// its target as `a.g` — a name nothing carries, so the real `a.b.g` goes
// missing. One line of legal C++ is enough; the same source across six lines is
// correct.
const innermostFirst = (a, b) =>
  (b.startLine - a.startLine) || (b.startCol - a.startCol) ||
  (a.endLine - b.endLine) || (a.endCol - b.endCol);

// The Go nodes that open a scope. Go's own list: a function body, a func
// literal, a plain block, an if / for / switch / select statement (its init
// statement is visible in the whole statement, else branch included), and each
// clause of a switch or select. A `function_type` is here so the parameter names
// of `cb func(x *T)` — which name nothing at run time — claim only that type.
const GO_SCOPE_NODES = new Set([
  'block', 'if_statement', 'for_statement', 'expression_switch_statement',
  'type_switch_statement', 'select_statement', 'expression_case', 'default_case',
  'type_case', 'communication_case', 'func_literal', 'function_declaration',
  'method_declaration', 'function_type', 'source_file',
]);

// The innermost scope a node sits in. Walking up can only ever land on a WIDER
// node, so a node type missing from the set above makes a scope too big, never
// too small — and too big keeps today's behaviour instead of inventing an answer.
function goScopeNode(node) {
  let n = node?.parent;
  while (n && !GO_SCOPE_NODES.has(n.type)) n = n.parent;
  return n;
}

// Where a name bound by a range clause, a type switch or a channel receive
// becomes visible. Go starts it after the clause, so the `x` on the right of
// `for _, x := range x.Next()` is still the OUTER x.
function goBindFromNode(nameNode) {
  let n = nameNode.parent;
  while (n && n.type !== 'range_clause' && n.type !== 'receive_statement' &&
         n.type !== 'type_switch_statement') n = n.parent;
  if (!n) return nameNode;
  if (n.type === 'type_switch_statement') return n.childForFieldName?.('value') ?? nameNode;
  return n;
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
  // A predeclared name (`string`, `any`, `int`, `error`) is qualified with the
  // package too, so a variable of that type gets a type name like "pkg.string"
  // that matches no node. That is deliberate, not an oversight: the row exists so
  // Pass B knows the type IS known and refuses the bare-name fallback. Skipping
  // predeclared types would leave `err.Error()` free to link to whichever repo
  // method happens to be named Error — a false edge we already removed.
  if (n.type === 'type_identifier') return pkg ? `${pkg}.${n.text}` : n.text;
  return null;
}

// The type node a Go initializer names, for the shapes that write the type right
// there: `T{}`, `&T{}` and `new(T)`. Anything else — a function call, a
// conversion, a channel receive — needs real type inference, so this returns null
// and the variable stays untyped.
function goInitTypeNode(expr) {
  let n = expr;
  // `(&T{})`. Parens change nothing about the type, only how far the operator
  // reaches, so unwrap them before looking at the shape underneath.
  while (n?.type === 'parenthesized_expression') n = n.namedChild(0);
  // `&T{}`. A composite literal is the only operand shape that names a type, so
  // there is no need to check the operator.
  if (n?.type === 'unary_expression') n = n.childForFieldName?.('operand');
  if (n?.type === 'composite_literal') return n.childForFieldName?.('type') ?? null;
  if (n?.type === 'call_expression' && n.childForFieldName?.('function')?.text === 'new') {
    return n.childForFieldName?.('arguments')?.namedChild(0) ?? null;
  }
  return null;
}

// True when some declaration enclosing `node` binds `name` as a type
// parameter — a placeholder that stands for whatever type the caller passes,
// not a real type. `class Box<T> { put(x: T) {} }`, `function f<T>(x: T) {}`
// and even one generic method inside an otherwise plain class
// (`class C { m<T>(x: T) {} }`) each carry their own `type_parameters` field
// holding `type_parameter` nodes with a `name` field — confirmed by parsing a
// fixture and printing the tree (see the fix report). A class, a function AND
// a method can all be generic, so this walks every ancestor up to the root
// instead of stopping at the nearest function: stopping early would still let
// `class Box<T> { put(x: T) { return x.logic(); } }` treat `T` as the class
// named `T` two lines above.
function tsBindsAsTypeParam(node, name) {
  for (let n = node; n; n = n.parent) {
    const typeParams = n.childForFieldName?.('type_parameters');
    if (!typeParams) continue;
    for (let i = 0; i < typeParams.namedChildCount; i++) {
      const p = typeParams.namedChild(i);
      if (p.type === 'type_parameter' && p.childForFieldName?.('name')?.text === name) return true;
    }
  }
  return false;
}

// The type a TypeScript declaration states, as written. A TS qname carries no
// package or module prefix — a top-level class `Conn` has the qname `Conn` — so the
// name as written is already the qname to look up, and no qualification is needed.
//
// Returns null for every shape a method call cannot be resolved through: a union, a
// function type, an array, a literal, `any`. A row is only worth writing when it
// names ONE type, because that is what the resolver's guards require.
//
// Also returns null when the bare name is bound as a generic type parameter
// rather than a real type (`function f<T>(x: T)`): otherwise a parameter named
// after an in-scope type variable is indistinguishable from one that really is
// typed as some repo class of the same name, and `T.logic()` would resolve as
// CERTAIN off nothing but a name collision — the exact false-knowledge bug
// this whole feature exists to remove.
function tsStatedTypeName(declNode) {
  const ann = declNode?.childForFieldName?.('type');          // `c: Conn`
  const t = ann?.type === 'type_annotation' ? ann.namedChild(0) : ann;
  // A dotted name (`foo.Bar`) is never a type parameter — a type parameter is
  // always one bare identifier — so only the two bare-name shapes need the check.
  const named = (name) => (tsBindsAsTypeParam(declNode, name) ? null : name);
  if (t) {
    // `Conn`, and `Conn | null` is deliberately not one type.
    if (t.type === 'type_identifier') return named(t.text);
    // `foo.Bar` — a namespace-qualified type. TS qnames are dotted the same way.
    if (t.type === 'nested_type_identifier') return t.text.replace(/\s/g, '');
    // `Conn<T>`: the generic arguments do not change which class owns the method.
    if (t.type === 'generic_type') {
      const base = t.childForFieldName?.('name');
      if (base?.type === 'type_identifier') return named(base.text);
      if (base?.type === 'nested_type_identifier') return base.text.replace(/\s/g, '');
    }
    return null;
  }
  // `const c = new Conn()`. The initialiser names the type outright, which is the
  // same fact Go reads from `x := &T{}`.
  const value = declNode?.childForFieldName?.('value');
  if (value?.type === 'new_expression') {
    const ctor = value.childForFieldName?.('constructor');
    if (ctor?.type === 'identifier') return named(ctor.text);
  }
  return null;
}

// The call a short declaration takes its value from: `x := reflect.ValueOf(v)`,
// `buf := bp.GetBuffer()`, `y := Make()`. Returns the call node, or null when the
// initializer is anything else. Parens and `new(T)` are already handled by
// goInitTypeNode, which names a real type and runs first.
function goInitCallNode(expr) {
  let n = expr;
  while (n?.type === 'parenthesized_expression') n = n.namedChild(0);
  if (n?.type !== 'call_expression') return null;
  if (n.childForFieldName?.('function')?.text === 'new') return null;
  return n;
}

// The names a Go declaration introduces, each paired with the type node that
// gives its type. Pairing runs through the node's own fields, never by position:
// `a, b *store.Postgres` has two names and one type and both must get a row, and
// a nested declaration would break any positional guess. Returns the name NODE,
// because a binding is identified by where it is written, not by its text alone.
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
      const init = paired ? right.namedChild(i) : null;
      const t = init ? goInitTypeNode(init) : null;
      out.push({ nameNode: name, typeNode: t, callNode: t ? null : (init ? goInitCallNode(init) : null) });
    }
    return out;
  }
  // `var_spec` and `const_spec` mark their comma tokens with the `name` field as
  // well, so filter on the node type — otherwise a row keyed on "," gets recorded.
  const names = [];
  for (let i = 0; i < decl.childCount; i++) {
    if (decl.fieldNameForChild(i) !== 'name') continue;
    const child = decl.child(i);
    if (child.type === 'identifier') names.push(child);
  }
  const declared = decl.childForFieldName?.('type');
  // `var x = &T{}` states the type in the initializer instead. One value per name,
  // same rule as a short declaration.
  const value = declared ? null : decl.childForFieldName?.('value');
  const perName = value && value.namedChildCount === names.length;
  for (let i = 0; i < names.length; i++) {
    const init = !declared && perName ? value.namedChild(i) : null;
    const t = declared ?? (init ? goInitTypeNode(init) : null);
    out.push({ nameNode: names[i], typeNode: t, callNode: t ? null : (init ? goInitCallNode(init) : null) });
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
// `namesAVar` answers whether an identifier names a variable that is in scope AT
// THIS CALL SITE rather than a package, so it takes the operand node and not just
// its text. It is asked BEFORE the import table on purpose: a variable shadows a
// package of the same name, and reading it as the package qualifies the call to
// the wrong package. hugo does this — a local `config` hides the imported package
// `config`, so `config.ToKeywords()` was recorded as a call into that package.
// Scope is positional: `watcher, err := watcher.New(...)` is ordinary Go, and the
// `watcher` on the right is still the package, because a variable's scope starts
// at the END of its own declaration.
function goCallTarget(c, { pkg, importPkgs, hasDotImport }, namesAVar = () => false) {
  const node = c.node;
  if (node?.type === 'field_identifier') {
    const operand = node.parent?.childForFieldName?.('operand');
    if (operand?.type === 'identifier') {
      if (!namesAVar(operand)) {
        // An imported package, under whatever name this file calls it.
        const importedAs = importPkgs.get(operand.text);
        if (importedAs) return `${importedAs}.${c.text}`;
        if (operand.text === pkg) return `${pkg}.${c.text}`;
      }
      return { bare: c.text, recvVar: operand.text, recvNode: operand, method: c.text };
    }
    if (operand?.type === 'selector_expression') {
      const innerRecv = operand.childForFieldName?.('operand');
      const innerField = operand.childForFieldName?.('field');
      if (innerRecv?.type === 'identifier' && innerField?.type === 'field_identifier') {
        return { bare: c.text, recvVar: innerRecv.text, recvNode: innerRecv,
                 field: innerField.text, method: c.text };
      }
    }
    return c.text; // receiver is an expression, not a name — keep bare name
  }
  if (pkg && !hasDotImport && !GO_BUILTINS.has(c.text)) return `${pkg}.${c.text}`;
  return c.text;
}

// The declarator that names a C++ function, found by walking past the wrappers a
// return type adds: `char* Buf::Data()` puts the function_declarator under a
// pointer_declarator, and `char*& Buf::Ref()` under a pointer_declarator holding
// a reference_declarator. Returns null when there is no function_declarator at
// all — which is what a macro before a class name does. Tree-sitter reads
// `class LEVELDB_EXPORT DB { … };` as a function definition whose declarator is
// the plain identifier `DB`, and indexing that would give the whole class body a
// function's name.
function cppFunctionDeclarator(node) {
  let n = node;
  while (n && (n.type === 'pointer_declarator' || n.type === 'reference_declarator')) {
    // A reference_declarator holds its child in no field, a pointer_declarator in
    // `declarator`, so try the field first and fall back to the first child.
    n = n.childForFieldName?.('declarator') ?? n.namedChild(0);
  }
  return n?.type === 'function_declarator' ? n : null;
}

// The name path a C++ declarator writes, outermost scope first:
//   `Get`            -> ['Get']
//   `PgStore::Get`   -> ['PgStore', 'Get']      an out-of-class definition
//   `a::b::f`        -> ['a', 'b', 'f']
//   `Vec<T>::At`     -> ['Vec', 'At']           the template arguments name no scope
//   `Buf::~Buf`      -> ['Buf', '~Buf']         a destructor
//   `Buf::operator==`-> ['Buf', 'operator==']   an operator overload
//   `::foo`          -> ['foo']                 global scope, so no scope to add
// Returns null for a shape we cannot name (a function pointer declarator), so
// the definition is skipped instead of indexed as "(anon)".
const CPP_NAME_NODES = ['identifier', 'field_identifier', 'destructor_name', 'operator_name'];
function cppNamePath(declarator) {
  const path = [];
  let n = declarator;
  while (n?.type === 'qualified_identifier') {
    const scope = n.childForFieldName?.('scope');
    // `Vec<T>::At` — the scope is the template, and the class is its `name`.
    if (scope) path.push(scope.type === 'template_type'
      ? (scope.childForFieldName?.('name')?.text ?? scope.text) : scope.text);
    n = n.childForFieldName?.('name');
  }
  // `template <> void f<int>() {}` — the name sits under the specialization.
  if (n?.type === 'template_function') n = n.childForFieldName?.('name');
  if (!n || !CPP_NAME_NODES.includes(n.type)) return null;
  path.push(n.text);
  return path;
}

// The class name a macro-broken class declaration writes.
// `class LEVELDB_EXPORT DB { … };` leaves tree-sitter no class to work with: it
// reads `class LEVELDB_EXPORT` as the type and the rest as a broken function
// definition (or, with two base classes, a broken declaration). The real name is
// still in the source, so read it from the text between the specifier and what
// follows: the LAST word before a base clause (`:`) or the body (`{`), with a
// trailing `final` dropped.
//
//   class M Name { … }              -> Name
//   class M Name final { … }        -> Name    the declarator field holds `final`
//   class M1 M2 Name { … }          -> Name    the declarator field holds M2
//   class M Name : public A { … }   -> Name
//   class M Name : public A, public B { … } -> Name
//
// Reading the declarator field instead is what named a class `final` or after the
// second macro. A wrongly-named class node is worse than none at all: it puts
// every member the class owns under an owner that does not exist. So this returns
// null whenever there is no word to read, and the definition is then skipped.
function cppMacroClassName(node, source) {
  const spec = node.childForFieldName?.('type');
  // A specifier that has its own body is not a broken parse. `struct P { int a; }
  // p;` and `struct P { … } make() { … }` are ordinary code, and the
  // class_specifier rule already indexed that class under its real name.
  if (!spec || spec.childForFieldName?.('body')) return null;
  // A declaration with a bodyless specifier is ordinary code too: `class Foo x;`
  // declares a variable of an existing class, and naming a class after `x` would
  // be pure invention. Only a broken parse leaves an ERROR node behind, so
  // require one before reading a class name out of a declaration.
  if (node.type === 'declaration') {
    let broken = false;
    for (let i = 0; i < node.childCount; i++) if (node.child(i).type === 'ERROR') broken = true;
    if (!broken) return null;
  }
  let head = source.slice(spec.endIndex, node.endIndex);
  // A base clause names OTHER classes, and the body names members, so cut both
  // off before looking for the name.
  for (const stop of [':', '{']) {
    const at = head.indexOf(stop);
    if (at >= 0) head = head.slice(0, at);
  }
  const words = head.match(/[A-Za-z_]\w*/g) ?? [];
  // `final` is written after the class name, never as one.
  while (words[words.length - 1] === 'final') words.pop();
  return words.length ? words[words.length - 1] : null;
}

// What a C++ call site names, and the bare method name to fall back on.
//
// `scope` is the qname of the class or namespace the call is written inside;
// `ns` is the qname of the nearest enclosing namespace only. C++ looks a name up
// in the innermost scope first, so recording the call that way is what lets the
// exact-qname pass answer it instead of a bare-name guess.
//
// `method` is set only when the bare name is still a legitimate fallback. An
// unqualified `TableFileName(...)` inside a member function may well be a free
// function rather than a member, so the fallback must stay open. A call the
// source qualified itself (`std::max(...)`) gets no fallback: the qualifier said
// where to look, and a repo symbol that merely shares the bare name is not it.
function cppCallTarget(c, scope, ns) {
  const node = c.node;
  if (node.type === 'qualified_identifier') {
    const path = cppNamePath(node);
    if (!path) return { dst_name: c.text, method: null };
    // A leading `::` starts the lookup at global scope (no `scope` field), so the
    // path is already absolute. With no enclosing namespace there is nothing to
    // resolve it against either.
    if (!node.childForFieldName?.('scope') || !ns) {
      return { dst_name: path.join('.'), method: null };
    }
    // C++ looks the FIRST segment of a qualifier up in the innermost scope first,
    // so the written qualifier has to be resolved against the enclosing namespace
    // path from the inside out. Inside `a::b`:
    //   `b::f()`     -> a.b.f    `b` names the scope we are already in
    //   `a::f()`     -> a.f      `a` names the scope one level out
    //   `a::b::f()`  -> a.b.f    the path is spelled in full
    //   `b::c::f()`  -> a.b.c.f  `c` is nested inside the scope we are in
    // Taking the LAST matching segment is what makes this innermost-first: in
    // `a.b` the segment `b` is nearer than `a`. Matching ANY segment and then
    // dropping the whole prefix is what made `b::f()` inside `a::b` answer with
    // the unrelated global `b::f` — a wrong answer marked certain.
    const segs = ns.split('.');
    const k = segs.lastIndexOf(path[0]);
    if (k >= 0) return { dst_name: [...segs.slice(0, k), ...path].join('.'), method: null };
    // The qualifier names no scope we are inside, so the innermost place it can
    // live is the enclosing namespace: `Status::OK()` inside `namespace leveldb`
    // means `leveldb::Status::OK`. It may instead live at an outer level, and the
    // source alone does not say which — so record the innermost reading only. If
    // no node carries that qname the call stays unresolved and the gap report
    // shows it, which is the honest answer; a second candidate at an outer scope
    // would be a pick, not a fact.
    return { dst_name: `${ns}.${path.join('.')}`, method: null };
  }
  // `x.m()` or `x->m()`. The receiver's type is unknown, so only `this` says
  // which type the call belongs to; any other receiver keeps the bare name.
  if (node.type === 'field_identifier') {
    const recv = node.parent?.childForFieldName?.('argument');
    if (recv?.type === 'this' && scope) return { dst_name: `${scope}.${c.text}`, method: c.text };
    return { dst_name: c.text, method: null };
  }
  if (scope) return { dst_name: `${scope}.${c.text}`, method: c.text };
  return { dst_name: c.text, method: null };
}

// The node a call's name sits under when the source wrote the call ON something
// — `x.end()` rather than `end()`. Checked against the vendored grammars: TS and
// JS put the property in a `member_expression`, Python in an `attribute`, C++ in
// a `field_expression`, Go in a `selector_expression`. A plain call's parent is
// the call node itself, and `new Service()`'s parent is a `new_expression`, so
// neither counts as a member access.
const MEMBER_PARENTS = new Set([
  'member_expression', 'attribute', 'field_expression', 'selector_expression',
]);

// The package a Python file's own relative imports count from. For `a/b.py` the
// package is `a`; for `a/__init__.py` the file IS the package `a`, so its own
// module path is the answer.
function pyOwnPackage(file, ownModule) {
  if (!ownModule) return null;
  if (file.endsWith('/__init__.py') || file === '__init__.py') return ownModule;
  const dot = ownModule.lastIndexOf('.');
  return dot < 0 ? '' : ownModule.slice(0, dot);
}

// The module path a `from ... import` statement counts from. An absolute
// `from x.y import z` gives "x.y". A relative one counts dots the way Python
// does: one dot is this file's own package, each extra dot climbs one level, and
// a suffix (`from .sub import z`) is appended. Returns null when the climb runs
// past the top, so nothing is invented.
function pyFromBase(stmt, ownPackage) {
  const mod = stmt?.childForFieldName?.('module_name');
  if (!mod) return null;
  if (mod.type === 'dotted_name') return mod.text;
  if (mod.type !== 'relative_import') return null;
  if (ownPackage === null) return null;
  let dots = 0, suffix = '';
  for (let i = 0; i < mod.childCount; i++) {
    const ch = mod.child(i);
    if (ch.type === 'import_prefix') dots = ch.text.length;
    else if (ch.type === 'dotted_name') suffix = ch.text;
  }
  if (dots === 0) return null;
  const parts = ownPackage ? ownPackage.split('.') : [];
  // One dot means "this package", so only the dots after the first climb.
  if (dots - 1 > parts.length) return null;
  const base = parts.slice(0, parts.length - (dots - 1)).join('.');
  if (!base) return suffix || null;
  return suffix ? `${base}.${suffix}` : base;
}

// What each name a Python file binds to a MODULE points at: bound name -> module
// path. A call written on one of these names is qualified by that module, not
// made on a value whose type we do not know.
//
// `repoModules` is every module path this repo can import. When it is given, a
// name is recorded only if the MODULE PATH it points at is one of them — the
// alias never decides. That is what stops `import json` plus `json.dumps()` from
// linking to a repo function called `dumps`: `json` is the standard library, so
// the call is on something we do not index and must stay a reported gap.
//
// Forms handled:
//   `import x`             binds x     -> x        (only the top segment is in scope)
//   `import x.y`           binds x     -> x
//   `import x as y`        binds y     -> x
//   `import x.y as z`      binds z     -> x.y
//   `from x import y`      binds y     -> x.y      only when x.y is a repo module
//   `from x import y as z` binds z     -> x.y      same
//   `from . import y`      binds y     -> <pkg>.y  same
// `from x import y` may bind a module OR an ordinary value, and the source does
// not say which. The repo-module check is what makes it safe to accept: a value
// re-exported from `__init__.py` has no module path of its own, so it is never
// recorded. Without `repoModules` (a direct `extract()` call with no index run
// behind it) the `from` forms are all refused, which is the older behaviour.
// `from x import *` binds no name we can see at all.
function pyModuleNames(caps, repoModules, ownPackage) {
  const bound = new Map();
  const record = (name, path) => {
    if (!name || !path) return;
    if (repoModules && !repoModules.has(path)) return;
    bound.set(name, path);
  };
  for (const c of caps) {
    if (c.name === 'import.from') {
      if (!repoModules) continue;
      const aliased = c.node?.parent?.type === 'aliased_import' ? c.node.parent : null;
      const stmt = aliased ? aliased.parent : c.node?.parent;
      if (stmt?.type !== 'import_from_statement') continue;
      const base = pyFromBase(stmt, ownPackage);
      if (!base) continue;
      record(aliased?.childForFieldName?.('alias')?.text ?? c.text, `${base}.${c.text}`);
      continue;
    }
    if (c.name !== 'reference.import') continue;
    const parent = c.node?.parent;
    // `import x.y as z` — the alias is the bound name, the whole path is the module.
    if (parent?.type === 'aliased_import' && parent.parent?.type === 'import_statement') {
      record(parent.childForFieldName?.('alias')?.text, c.text);
      continue;
    }
    // A plain `import x.y`. Only the top segment is a name in scope.
    // Any other parent (`import_from_statement`, `relative_import`) points at the
    // module a `from` statement reads FROM, which this file does not bind.
    if (parent?.type === 'import_statement') record(c.text.split('.')[0], c.text.split('.')[0]);
  }
  return bound;
}

// The Python nodes that open a scope. A name assigned anywhere inside a function
// is local to that WHOLE function — Python has no block scope — so the function's
// own span is the right span for the binding. A class body is its own scope too;
// using it (rather than the module) keeps an over-refusal inside that one class.
const PY_SCOPE_NODES = new Set(['function_definition', 'class_definition', 'lambda', 'module']);

// The TypeScript/JavaScript nodes that open a scope. `let` and `const` are
// block-scoped, so a plain block counts; a function's parameters belong to the
// function. Missing a node type here makes a scope too WIDE, which keeps today's
// answer instead of inventing one — the same trade the Go set makes.
const TS_SCOPE_NODES = new Set([
  'statement_block', 'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'class_body', 'for_statement', 'for_in_statement',
  'catch_clause', 'switch_case', 'switch_default', 'program',
]);

// The dotted object path a Python call was written on, head first:
// `requests.cookies.RequestsCookieJar()` -> ['requests', 'cookies']. Returns null
// as soon as the chain holds anything but plain names (a subscript, a call, a
// string), because then the head no longer decides what the object is.
function pyObjectPath(obj) {
  const parts = [];
  let n = obj;
  while (n?.type === 'attribute') {
    const attr = n.childForFieldName?.('attribute');
    if (attr?.type !== 'identifier') return null;
    parts.unshift(attr.text);
    n = n.childForFieldName?.('object');
  }
  if (n?.type !== 'identifier') return null;
  parts.unshift(n.text);
  return parts;
}

// The type a `this.m()` / `self.m()` call belongs to, for languages where qname
// comes from lexical nesting (TS/JS, Python). C++ has its own path — see
// cppCallTarget — because a C++ method is often defined outside its class, so
// lexical nesting cannot say which type owns it. The owning type is
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

// The node types the "function passed as a call argument" capture can produce.
// In TS/JS a definition is only ever one of these through that one capture, so
// the node type is what tells a callback definition apart from every other one.
//
// WHY THEY ARE NOT ALL KEPT. An inline `xs.map(x => target() + x)` written inside
// a named function is ALREADY attributed to that function, which is both right and
// useful. Indexing every call-argument function would replace that caller with an
// anonymous arrow, and `impact` would stop there — nothing calls an arrow that is
// passed as a value. So a callback is indexed only when no named definition
// encloses it. A callback inside another callback is kept: `it` inside `describe`
// should attribute to `it`, and the innermost-parent pick gives that for free once
// both are definitions.
const CALLBACK_DEF_TYPES = new Set(['arrow_function', 'function_expression', 'generator_function']);

// The name a call-argument function goes by. It has none of its own, but the call
// beside it usually carries a string: `it('case', …)` -> `it:case`, which reads as
// the test's name in `callers` output — what a human wants to see. With no string
// first argument the line is the only thing separating two callbacks passed to the
// same function, so use that: `beforeEach@42`.
//
// Neither shape can collide with an identifier, because no identifier in these
// grammars holds a `:` or a `@`. That is what makes the whole feature additive: a
// call can never resolve TO one of these definitions, so no resolver pass and no
// certainty rule had to change.
//
// The label is flattened and capped. A test name can be a multi-line template
// literal, and a newline inside a qname would break one line of `callers` output
// into two. Two tests whose names share the first 80 characters get the same qname,
// which is harmless — the node id carries an `ord` that separates them.
function callbackDefName(cb) {
  const args = cb.parent;                       // (arguments …)
  const call = args?.parent;                    // (call_expression …)
  let fn = call?.childForFieldName?.('function');
  // `it.runIf(cond)('case', …)` calls the RESULT of a call, so the name of the
  // thing being called has to be read one level in.
  while (fn?.type === 'call_expression') fn = fn.childForFieldName?.('function');
  const callee = fn?.type === 'identifier' ? fn.text
    : fn?.type === 'member_expression' ? (fn.childForFieldName?.('property')?.text ?? null)
      : null;
  const first = args?.namedChild?.(0);
  const label = first && (first.type === 'string' || first.type === 'template_string')
    ? first.text.slice(1, -1).replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
  const base = callee ?? 'callback';
  return label ? `${base}:${label}` : `${base}@${cb.startPosition.row + 1}`;
}

// `pyRepoModules` is what an index run knows and a single file cannot: every
// Python module path the repo can import ({ paths, byFile }, see pyModuleIndex in
// index/build.mjs). Without it the Python import rules fall back to the older,
// narrower behaviour — a plain `import x` only, and no repo check — so calling
// extract() directly still works.
export async function extract({ file, lang, langId, scm, source, pyRepoModules = null }) {
  const language = await loadLanguage(langId);
  const caps = await parseAndQuery(language, scm, source);
  const goCtx = lang === 'go' ? goContext(caps) : null;
  const pyOwnPkg = lang === 'py' && pyRepoModules
    ? pyOwnPackage(file, pyRepoModules.byFile.get(file) ?? null) : null;
  const pyModules = lang === 'py'
    ? pyModuleNames(caps, pyRepoModules?.paths ?? null, pyOwnPkg) : null;

  const defKinds = ['function', 'method', 'class', 'struct', 'interface', 'type', 'enum', 'namespace'];
  const defs = [];
  const defCaps = caps.filter((c) => c.name.startsWith('definition.'));
  const nameCaps = caps.filter((c) => c.name === 'name');
  const recvCaps = caps.filter((c) => c.name === 'receiver');
  const recvNameCaps = caps.filter((c) => c.name === 'receiver.name');
  for (const d of defCaps) {
    const kind = d.name.split('.')[1];
    if (!defKinds.includes(kind)) continue;
    // A C++ function definition carries its own name path in its declarator, so
    // it needs no `@name` capture: `PgStore::Get` says which class owns it even
    // though the class itself is declared in another file.
    let localPath = null;
    if (lang === 'cpp' && kind === 'function') {
      const fd = cppFunctionDeclarator(d.node.childForFieldName?.('declarator'));
      const path = fd ? cppNamePath(fd.childForFieldName?.('declarator')) : null;
      if (!path) continue; // a shape we cannot name — see cppFunctionDeclarator
      localPath = path.join('.');
    }
    // A class whose name a macro pushed out of the parse. The captured node is
    // the broken function definition or declaration, not a class_specifier, and
    // the name has to be read from the source — see cppMacroClassName.
    if (lang === 'cpp' && (kind === 'class' || kind === 'struct') &&
        d.node.type !== 'class_specifier' && d.node.type !== 'struct_specifier') {
      const recovered = cppMacroClassName(d.node, source);
      if (!recovered) continue; // too broken to name — a wrong owner is worse
      localPath = recovered;
    }
    // A callback has no name of its own, and the `@name` captures inside its span
    // belong to something else: a nested `function helper()` would otherwise name
    // the callback `helper`, and the real one would become `helper.helper`. So the
    // name is read from the call beside it and nameCap is skipped.
    const isCallback = (lang === 'ts' || lang === 'js') &&
      CALLBACK_DEF_TYPES.has(d.node?.type ?? '');
    const ownName = isCallback ? callbackDefName(d.node) : null;
    // The outermost name inside this definition is its own. The column has to
    // break a line tie or the pick is left to capture order: in
    // `const Widget = class { render() {} };` both `Widget` and `render` are
    // `@name` captures on line 1 inside the same span, and the leftmost is the
    // one the definition is called.
    const nameCap = (localPath || ownName) ? null : nameCaps
      .filter((n) => within(n, d))
      .sort((a, b) => (a.startLine - b.startLine) || (a.startCol - b.startCol))[0];
    // `namespace a::b { … }` is one node that names two namespaces. Split it so
    // a function inside gets the qname `a.b.f`, which is what a call written
    // `a::b::f()` records.
    if (lang === 'cpp' && kind === 'namespace' && nameCap?.text.includes('::')) {
      localPath = nameCap.text.split('::').join('.');
    }
    defs.push({
      kind, localPath, isCallback,
      name: localPath ? localPath.slice(localPath.lastIndexOf('.') + 1)
        : (ownName ?? nameCap?.text ?? '(anon)'),
      startLine: d.startLine, endLine: d.endLine,
      startCol: d.startCol, endCol: d.endCol,
      signature: capSignature(source.split('\n')[d.startLine - 1]?.trim() ?? ''),
      node: d.node, // kept for containment checks below; never copied into `nodes`
    });
  }

  // Collapse defs that occupy the exact same span into one, keeping the most
  // specific kind. A grouped Go `type_spec` matches both its shape-specific rule
  // (struct/interface) and the generic `@definition.type` rule, so the same node
  // is captured twice; without this the two identical-span defs would look like
  // parent/child to `within()` and produce a bogus `X.X` qname (and an undefined
  // container_id that then fails the DB insert, dropping the whole file).
  const KIND_SPECIFICITY = { struct: 3, interface: 3, enum: 3, class: 3, namespace: 3, type: 2, function: 1, method: 1 };
  const bySpan = new Map();
  for (const d of defs) {
    const span = `${d.startLine}:${d.startCol}:${d.endLine}:${d.endCol}`;
    const prev = bySpan.get(span);
    if (!prev || (KIND_SPECIFICITY[d.kind] ?? 0) > (KIND_SPECIFICITY[prev.kind] ?? 0)) bySpan.set(span, d);
  }
  const dedupedDefs = [...bySpan.values()];
  defs.length = 0;
  defs.push(...dedupedDefs);

  // Keep only the callbacks no named definition encloses — see CALLBACK_DEF_TYPES
  // for what that buys and what it protects. Runs after the span dedup, so
  // "encloses" is asked of one definition per span.
  if (defs.some((d) => d.isCallback)) {
    const kept = defs.filter((d) => !d.isCallback ||
      !defs.some((p) => !p.isCallback && within(d, p)));
    defs.length = 0;
    defs.push(...kept);
  }

  // Outermost first, so a parent's qname is always built before its children's.
  // The columns have to break the line ties: `namespace a { namespace b { void
  // f() {} } }` puts three definitions on one line, and lines alone cannot order
  // them.
  defs.sort((a, b) =>
    (a.startLine - b.startLine) || (a.startCol - b.startCol) ||
    (b.endLine - a.endLine) || (b.endCol - a.endCol));
  const ordSeen = new Map();
  for (const def of defs) {
    // The innermost definition around this one — see innermostFirst.
    const parent = defs.filter((p) => within(def, p)).sort(innermostFirst)[0];
    // C++ writes the owner into the declarator (`PgStore::Get`), so the
    // definition names its own path and nesting only adds what encloses it.
    const local = def.localPath ?? def.name;
    if (parent) {
      // Nesting already carries any package prefix through the parent's qname.
      def.qname = `${parent.qname}.${local}`;
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
      def.qname = local;
    }
    if (lang === 'cpp') {
      // The scope a name written inside this definition is looked up in first,
      // and the nearest enclosing namespace on its own. A definition that is
      // itself a scope (a class, a struct, a namespace) is its own answer;
      // anything else hands over whatever owns it.
      def.cppScope = OWNER_KINDS.has(def.kind)
        ? def.qname
        : (def.qname.includes('.') ? def.qname.slice(0, def.qname.lastIndexOf('.')) : null);
      def.cppNs = def.kind === 'namespace' ? def.qname : (parent?.cppNs ?? null);
      // A definition whose declarator names a class (`PgStore::Get`), or that
      // sits in a class body, is a method. A namespace-qualified out-of-line
      // definition (`a::b::f`) is labelled a method too — the source alone does
      // not say whether `a::b` is a class or a namespace, and a member is by far
      // the common case.
      if (def.kind === 'function' &&
          (def.localPath?.includes('.') || parent?.kind === 'class' || parent?.kind === 'struct')) {
        def.kind = 'method';
      }
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
    // The declared result type of a repo function or method, keyed "<qname>#ret".
    // Read here like every other type fact, joined at build time: a variable
    // declared `x := pkg.Make()` records "#ret:pkg.Make", and the resolver follows
    // that to this row to learn what x is. Without it the call on x falls back to
    // a bare name — the largest remaining source of false rows.
    //
    // Only a single result that names a type counts. `(T, error)` is a
    // parameter_list, and a slice, map or func type names nothing we can resolve a
    // method call through, so goFieldTypeName returns null and no row is written.
    for (const def of defs) {
      if (def.kind !== 'function' && def.kind !== 'method') continue;
      const result = def.node?.childForFieldName?.('result');
      const type = result ? goFieldTypeName(result, goCtx.pkg) : null;
      if (type) fieldTypes.push({ key: `${def.qname}#ret`, type, file });
    }
    const fieldDeclCaps = caps.filter((c) => c.name === 'field.decl');
    for (const fd of fieldDeclCaps) {
      const structDef = defs
        .filter((d) => d.kind === 'struct' && within(fd, d))
        .sort(innermostFirst)[0];
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

  // Parameter and variable types. They go in the same table as struct fields so
  // the same resolver passes and the same guards apply, with no new resolver code:
  // Pass F resolves "<type>.<method>", and Pass B refuses the bare-name fallback
  // when the type is known but is not a repo type. `goFieldTypeName` returns null
  // for shapes we do not resolve through (slice, map, func, inline interface), so
  // an unnameable type records nothing and that call keeps today's behaviour.
  //
  // WHAT A KEY IDENTIFIES, because the resolver's guards depend on it:
  //   "<def id>#var:<name>@<line>:<col>"  ONE binding — one name written at one
  //     place inside one definition. The def id (not its qname) starts the key
  //     because a qname is not unique: Go allows many `func init()` per package,
  //     and two directories can hold same-named functions of the same package
  //     name. The position ends it because one function can bind one name many
  //     times, in sibling blocks or nested closures, each with its own type.
  //   "<dir>:<pkg>#pkgvar:<name>"  ONE package-level variable. Every file of a Go
  //     package sits in one directory, so the directory plus the package name is
  //     the package. The package name alone is not: hugo has 25 package names that
  //     span more than one directory, and sharing a key across them let one
  //     directory's type answer another's call.
  // Both shapes therefore name a single declaration site, which is what makes Pass
  // F's "exactly one known type for this key" guard a genuine conflict check.
  // Neither can collide with a struct-field key — `#` is not legal in a Go
  // identifier.
  //
  // A binding is recorded even when its type cannot be read. A call on such a name
  // must stay a guess, and knowing the name is bound here is what stops it from
  // being answered with a package-level type that happens to share it.
  const dirOf = (p) => (p.lastIndexOf('/') < 0 ? '' : p.slice(0, p.lastIndexOf('/')));
  // Built here so nothing dereferences goCtx outside the guard below.
  const pkgVarScope = goCtx?.pkg ? `${dirOf(file)}:${goCtx.pkg}` : null;
  const pkgVarKey = (name) => (pkgVarScope ? `${pkgVarScope}#pkgvar:${name}` : null);
  // Every Go name this file binds, with the span it is visible in, grouped by name
  // so a call site asks about one name and not about every binding in the file.
  const bindings = new Map(); // name -> [binding, ...]
  // binding key -> the one type this file recorded for it. Used for `x.f.M()`,
  // where the field key needs the type that owns the field named at extraction.
  const varTypes = new Map();
  if (goCtx) {
    const ownerOf = (cap) => defs.filter((d) => within(cap, d)).sort(innermostFirst)[0];
    // `fromNode` is the node a name becomes visible AFTER. Go starts a variable's
    // scope at the end of its own declaration, which is why the right-hand side of
    // `watcher, err := watcher.New(...)` still reads `watcher` as the package.
    // A variable whose value comes from a call has a type we cannot read: the
    // declaration is in the callee, often in another package or outside the repo
    // (`x := reflect.ValueOf(v)`). Record the CALLEE instead of a type, under a
    // "#ret:" prefix that can never be a Go type name. Nothing resolves through
    // it — its whole job is to tell the resolver the type is decided elsewhere, so
    // Pass B's guard refuses the bare-name fallback instead of guessing that the
    // one repo method sharing the name is the target. That guess is the largest
    // remaining source of false rows.
    const retTypeOf = (callNode) => {
      const fn = callNode.childForFieldName?.('function');
      if (!fn) return null;
      if (fn.type === 'identifier') return `#ret:${goCtx.pkg}.${fn.text}`;
      if (fn.type === 'selector_expression') {
        const head = fn.childForFieldName?.('operand');
        const field = fn.childForFieldName?.('field');
        if (head?.type !== 'identifier' || !field) return null;
        // Translate an import alias the same way a call site is translated, so a
        // later pass can look the callee up by the name the graph stores.
        const pkgName = goCtx.importPkgs.get(head.text) ?? head.text;
        return `#ret:${pkgName}.${field.text}`;
      }
      return null; // a call on an expression: nothing to name
    };
    const bind = (cap, nameNode, typeNode, fromNode, callNode = null) => {
      // `_` binds nothing a later line can read — Go itself refuses to read it
      // back. Recording a type for it anyway is how two unrelated files each
      // writing `var _ SomeIface = &Impl{}` (the interface-assertion idiom)
      // turn into a false "conflict" on the shared package-level key: nothing
      // can ever call through `_`, so there is no binding here to record.
      if (nameNode.text === '_') return;
      const owner = ownerOf(cap);
      const scope = goScopeNode(nameNode);
      if (!scope) return;
      // `ownerOf` only finds a NAMED function, method or type. A closure that
      // sits at package level (`var handlers = map[string]func(){ "x": func()
      // { conf := ... } }`) has none — but its body is still a local scope, not
      // the whole file. The scope node is what tells the two apart: only a
      // `source_file` scope with no owner is really package level; anything
      // narrower is a local, wherever it sits. Getting this wrong merges the
      // local with a real package variable of the same name.
      const pkgLevel = !owner && scope.type === 'source_file';
      const key = owner
        ? `${owner.id}#var:${nameNode.text}@${nameNode.startPosition.row + 1}:${nameNode.startPosition.column}`
        : pkgLevel
          ? pkgVarKey(nameNode.text)
          : `${file}#var:${nameNode.text}@${nameNode.startPosition.row + 1}:${nameNode.startPosition.column}`;
      if (!key) return; // a package-level name in a file with no package clause
      if (!bindings.has(nameNode.text)) bindings.set(nameNode.text, []);
      bindings.get(nameNode.text).push({
        key,
        // A package-level name is visible in the whole file wherever it is
        // written, so it has no "from" position; any local does, even one
        // whose owning function or method could not be found.
        fromLine: pkgLevel ? 0 : fromNode.endPosition.row + 1,
        fromCol: pkgLevel ? 0 : fromNode.endPosition.column,
        startLine: scope.startPosition.row + 1, startCol: scope.startPosition.column,
        endLine: scope.endPosition.row + 1, endCol: scope.endPosition.column,
      });
      const typeName = typeNode ? goFieldTypeName(typeNode, goCtx.pkg)
        : (callNode ? retTypeOf(callNode) : null);
      if (!typeName) return;
      // A "#ret:" row names a callee, not a type, so it must not be offered as
      // one: `x.f.M()` keys on the type that owns the field `f`, and there is no
      // such type here.
      if (typeName.startsWith('#ret:')) { fieldTypes.push({ key, type: typeName, file }); return; }
      fieldTypes.push({ key, type: typeName, file });
      // One key is one binding, so a second type for it can only come from two
      // query patterns matching the same declaration. Refuse rather than pick.
      varTypes.set(key, varTypes.has(key) && varTypes.get(key) !== typeName ? null : typeName);
    };
    for (const vd of caps.filter((c) => c.name === 'var.decl')) {
      for (const { nameNode, typeNode, callNode } of goVarDeclNames(vd.node)) {
        bind(vd, nameNode, typeNode, vd.node, callNode);
      }
    }
    for (const vl of caps.filter((c) => c.name === 'var.local')) {
      bind(vl, vl.node, null, goBindFromNode(vl.node));
    }
    // Innermost scope last: two scopes that both hold one point are nested, and
    // the inner one always opens later. Within one scope the latest binding wins.
    for (const list of bindings.values()) {
      list.sort((a, b) =>
        a.startLine - b.startLine || a.startCol - b.startCol ||
        a.fromLine - b.fromLine || a.fromCol - b.fromCol);
    }
  }
  // The binding a name refers to at one position, or null when none is in scope.
  const bindingAt = (name, node) => {
    const line = node.startPosition.row + 1, col = node.startPosition.column;
    let found = null;
    for (const b of bindings.get(name) ?? []) {
      if (!posLE(b.fromLine, b.fromCol, line, col)) continue; // not visible yet
      if (!posLE(b.startLine, b.startCol, line, col)) continue; // another scope
      if (!posLE(line, col, b.endLine, b.endCol)) continue;
      found = b; // sorted innermost-last, so the last hit is the one Go picks
    }
    return found;
  };

  // Every name a Python scope in this file binds to a VALUE, with the span that
  // binding covers. An imported module name can be shadowed by a local or a
  // parameter — `import api` at the top and `def run(rows): api = rows[0]` below
  // — and then `api.load(...)` is a call on a row, not on the module. Go already
  // refuses that case (the hugo `config` bug); this is Python's version of it.
  //
  // Python needs no position check, unlike Go: a name assigned anywhere in a
  // function is local to the whole function, so reading it before the assignment
  // is an error, not a reference to the module.
  const pyValueNames = new Map(); // name -> [span, ...]
  // The same bindings again, but keyed, so a call written ON one of them can be
  // looked up by the resolver. One key is one name in one Python scope: Python has
  // no block scope, so unlike Go no position is needed to tell two bindings apart.
  const pyVarKeys = new Map(); // name -> [{ key, span }, ...]
  if (lang === 'py') {
    for (const c of caps) {
      if (c.name !== 'var.local') continue;
      let scope = c.node?.parent;
      while (scope && !PY_SCOPE_NODES.has(scope.type)) scope = scope.parent;
      if (!scope) continue;
      const span = {
        startLine: scope.startPosition.row + 1, startCol: scope.startPosition.column,
        endLine: scope.endPosition.row + 1, endCol: scope.endPosition.column,
      };
      if (!pyValueNames.has(c.text)) pyValueNames.set(c.text, []);
      pyValueNames.get(c.text).push(span);
      // A module is one file in Python, so a module-level name is keyed on the
      // file. Anything narrower is keyed on the definition that holds it, by id:
      // a qname is not unique (two classes can each hold a method of one name).
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      const key = owner ? `${owner.id}#var:${c.text}` : `${file}#var:${c.text}`;
      if (!pyVarKeys.has(c.text)) pyVarKeys.set(c.text, []);
      pyVarKeys.get(c.text).push({ key, span });
    }
    // `close_server = threading.Event()` and `jar = RequestsCookieJar()` look the
    // same to a parser: a name bound to the result of a call. Record the callee
    // under the name's key, exactly as Go does for `x := pkg.Make()`. The resolver
    // then finds the repo class and answers certainly, or finds nothing — and a
    // call on that name is refused instead of guessing the one repo method that
    // shares its bare name. Those guesses were 39 false rows on psf/requests.
    for (const c of caps) {
      if (c.name !== 'var.local') continue;
      const assign = c.node?.parent;
      if (assign?.type !== 'assignment') continue;
      // Compare positions, not objects: every childForFieldName call hands back a
      // fresh wrapper for the same node, so `!==` is always true.
      const left = assign.childForFieldName?.('left');
      if (!left || left.startIndex !== c.node.startIndex) continue; // not a plain `x = …`
      const value = assign.childForFieldName?.('right');
      if (value?.type !== 'call') continue;
      const fn = value.childForFieldName?.('function');
      if (!fn) continue;
      let callee = null;
      if (fn.type === 'identifier') callee = fn.text;
      else if (fn.type === 'attribute') {
        // `mod.Cls()`: the head is translated through this file's imports, the same
        // way a module-qualified CALL is. A repo module leaves the class reachable
        // by its own (bare) qname; anything else keeps the dotted path, which no
        // node carries — which is the point, because that type is not ours.
        const path = pyObjectPath(fn.childForFieldName?.('object'));
        const attr = fn.childForFieldName?.('attribute');
        if (path && attr) {
          const modulePath = pyModules.get(path[0]);
          const full = modulePath ? [modulePath, ...path.slice(1)].join('.') : path.join('.');
          const isRepoModule = pyRepoModules ? pyRepoModules.paths.has(full) : false;
          callee = isRepoModule ? attr.text : `${full}.${attr.text}`;
        }
      }
      if (!callee) continue;
      // The key is built exactly as the binding loop above builds it, so a row and
      // the call site that reads it cannot drift apart.
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      fieldTypes.push({
        key: owner ? `${owner.id}#var:${c.text}` : `${file}#var:${c.text}`,
        type: `#ret:${callee}`, file,
      });
    }
  }
  // The same idea as the Python and Go binding maps: one entry per name per scope,
  // so a call written on a name can be keyed and looked up later. The position is
  // part of the key because one function can bind one name in several scopes.
  const tsVarKeys = new Map(); // name -> [{ key, span }, ...]
  if (lang === 'ts' || lang === 'js') {
    for (const c of caps) {
      if (c.name !== 'var.decl') continue;
      let scope = c.node?.parent;
      while (scope && !TS_SCOPE_NODES.has(scope.type)) scope = scope.parent;
      if (!scope) continue;
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      const at = `@${c.node.startPosition.row + 1}:${c.node.startPosition.column}`;
      const key = owner ? `${owner.id}#var:${c.text}${at}` : `${file}#var:${c.text}${at}`;
      if (!tsVarKeys.has(c.text)) tsVarKeys.set(c.text, []);
      tsVarKeys.get(c.text).push({
        key,
        node: c.node,
        span: {
          startLine: scope.startPosition.row + 1, startCol: scope.startPosition.column,
          endLine: scope.endPosition.row + 1, endCol: scope.endPosition.column,
        },
      });
    }
    // A stated type goes in the same table as Go's and Python's, so the SAME
    // resolver passes answer it: Pass F links `<type>.<method>`, and Pass B refuses
    // the bare-name fallback when a type is recorded but leads nowhere — which is
    // what an imported type from outside the repo does.
    for (const [, binds] of tsVarKeys) {
      for (const b of binds) {
        // The declaration is the parameter or the declarator, not the name node.
        const decl = b.node.parent;
        const type = tsStatedTypeName(decl);
        if (type) { fieldTypes.push({ key: b.key, type, file }); continue; }
        // No type stated. In TypeScript a parameter without one is typed by the
        // signature it is passed to — a library's callback, most of the time — so
        // the type is decided somewhere this repo cannot read. Record that fact:
        // the resolver then refuses the bare-name fallback instead of answering
        // with the one repo method that shares the name. On sindresorhus/got that
        // guess printed 89 wrong rows for `setHeader`, every one of them
        // `response.setHeader(...)` inside `server.all('/x', (request, response) =>
        // …)`.
        //
        // Parameters only, and TypeScript only. A `const` or `let` with no
        // annotation takes its type from an initialiser this rule cannot read —
        // nest writes `const module = await Test.createTestingModule(…).compile()`,
        // and refusing there would throw away 190 rows that are all correct.
        // JavaScript annotates nothing at all, so the rule would refuse every
        // member call in a .js file.
        //
        // "No annotation" means no annotation NODE, not an annotation this reader
        // cannot use. `w: any` is a stated fact — the author said the value can be
        // anything — and so are a union and a function type. Refusing those would
        // remove a lead the source never contradicted; refusing an unannotated
        // parameter removes a guess the source cannot support.
        const isParam = decl?.type === 'required_parameter' || decl?.type === 'optional_parameter' ||
          decl?.type === 'arrow_function';
        const annotated = Boolean(decl?.childForFieldName?.('type'));
        if (lang === 'ts' && isParam && !annotated) fieldTypes.push({ key: b.key, type: '#param', file });
      }
    }
  }
  // The binding in scope at this point, innermost first: of two scopes that both
  // hold one position, the inner one always starts later.
  const tsBindingAt = (name, node) => {
    const line = node.startPosition.row + 1, col = node.startPosition.column;
    const hits = (tsVarKeys.get(name) ?? []).filter((b) =>
      posLE(b.span.startLine, b.span.startCol, line, col) &&
      posLE(line, col, b.span.endLine, b.span.endCol));
    hits.sort((a, b) => b.span.startLine - a.span.startLine || b.span.startCol - a.span.startCol);
    return hits[0] ?? null;
  };
  const tsVarKeyAt = (name, node) => tsBindingAt(name, node)?.key ?? null;
  // The key a call written on a plain Python name belongs to, or null when the name
  // is not bound in this scope (a module, or something we did not capture).
  const pyVarKeyAt = (name, node) => {
    const line = node.startPosition.row + 1, col = node.startPosition.column;
    for (const b of pyVarKeys.get(name) ?? []) {
      if (posLE(b.span.startLine, b.span.startCol, line, col) &&
          posLE(line, col, b.span.endLine, b.span.endCol)) return b.key;
    }
    return null;
  };
  const pyNamesAValue = (name, node) => {
    const line = node.startPosition.row + 1, col = node.startPosition.column;
    for (const s of pyValueNames.get(name) ?? []) {
      if (posLE(s.startLine, s.startCol, line, col) && posLE(line, col, s.endLine, s.endCol)) return true;
    }
    return false;
  };

  const refMap = { 'reference.call': 'call', 'reference.import': 'import', 'reference.include': 'include' };
  const edges = [];
  for (const c of caps) {
    const kind = refMap[c.name];
    if (!kind) continue;
    const enclosing = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
    let dst_name, field_key = null, method = null;
    // An identifier names a variable, not a package, when a binding for it is in
    // scope right here. Every fact used is file-local, and that is exactly right:
    // an import is file-scoped in Go, so a package-level name declared in ANOTHER
    // file cannot shadow this file's import.
    const namesAVar = (node) => Boolean(bindingAt(node.text, node));
    // The key to look a call on a plain identifier up under. A binding in scope
    // wins, because Go reads the innermost scope first. With no binding in scope
    // the name belongs to package scope — possibly declared in another file of the
    // package, which is why this key is not file-local.
    const varKeyFor = (name, node) => bindingAt(name, node)?.key ?? pkgVarKey(name);
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
        const recvType = varTypes.get(varKeyFor(target.recvVar, target.recvNode));
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
        field_key = varKeyFor(target.recvVar, target.recvNode);
        if (field_key) method = target.method;
      }
    } else if (kind === 'call' && lang === 'cpp') {
      // C++ looks a name up in the enclosing class and namespace before the
      // global scope, and it writes an out-of-class definition as
      // `PgStore::Get`. Recording the call the same way is what lets the exact
      // qname pass answer it instead of a bare-name guess.
      const t = cppCallTarget(c, enclosing?.cppScope ?? null,
        (enclosing?.kind === 'namespace' ? enclosing.qname : enclosing?.cppNs) ?? null);
      dst_name = t.dst_name;
      method = t.method;
    } else {
      dst_name = target;
      // Same idea for lexically-nested languages: `this.m()` / `self.m()` belongs
      // to the enclosing type, so name it instead of leaving an ambiguous bare `m`.
      if (kind === 'call' && !goCtx) {
        const owner = selfCallOwner(c, lang, defs, enclosing);
        if (owner) { dst_name = `${owner.qname}.${c.text}`; method = c.text; }
        // `jar.set(...)` in Python: key the call on the receiver name, the same way
        // Go keys `db.Get()`. With a type recorded for that name the resolver
        // answers exactly; with none it keeps today's fallback.
        else if (lang === 'py' && c.node?.parent?.type === 'attribute') {
          const obj = c.node.parent.childForFieldName?.('object');
          if (obj?.type === 'identifier') {
            const key = pyVarKeyAt(obj.text, obj);
            if (key) { field_key = key; method = c.text; }
          }
        }
        // `c.query(...)` in TypeScript: key the call on the receiver name, exactly
        // as Go keys `db.Get()` and Python keys `jar.set()`. With a type recorded
        // for that name the resolver answers it; with none, nothing changes.
        else if ((lang === 'ts' || lang === 'js') && c.node?.parent?.type === 'member_expression') {
          const obj = c.node.parent.childForFieldName?.('object');
          if (obj?.type === 'identifier') {
            const key = tsVarKeyAt(obj.text, obj);
            if (key) { field_key = key; method = c.text; }
          }
        }
      }
    }
    // A plain-identifier call to a builtin or a predeclared type names nothing in
    // the repo. Marked here, once, so neither the resolver nor the gap report has
    // to keep a Go word list in SQL.
    const external = lang === 'go' && c.node?.type !== 'field_identifier' &&
      (GO_BUILTINS.has(c.text) || GO_PREDECLARED_TYPES.has(c.text)) ? 1 : 0;
    // Was the call written on something? Recorded for every language, because the
    // resolver then refuses a target that is not a member of a type — `end`
    // declared inside one method body can never answer `response.end()`.
    let member = kind === 'call' && MEMBER_PARENTS.has(c.node?.parent?.type ?? '') ? 1 : 0;
    // A Python call whose object names a module is qualified by that module; it is
    // not made on a value. Python qnames carry no module prefix, so the bare
    // function name stays the target and the member flag is cleared —
    // `requests.get(...)` still resolves while `s.get(...)` does not.
    //
    // The object may be a dotted path: `requests.cookies.RequestsCookieJar()` is
    // written on the module `requests.cookies`. So the head name is translated
    // through the file's imports and the remaining segments are appended, and the
    // WHOLE path must be a module the repo can import. That is what separates
    // `requests.cookies` (a real submodule) from `requests.codes` (a lookup table
    // object) and from `os.environ` — both of which stay refused.
    //
    // With no repo module list (a direct extract() call) only a plain name can
    // clear the flag, which is the older behaviour.
    if (member === 1 && lang === 'py') {
      const path = pyObjectPath(c.node.parent.childForFieldName?.('object'));
      const head = path?.[0];
      const modulePath = head ? pyModules.get(head) : null;
      if (modulePath && !pyNamesAValue(head, c.node)) {
        const full = [modulePath, ...path.slice(1)].join('.');
        if (pyRepoModules ? pyRepoModules.paths.has(full) : path.length === 1) member = 0;
      }
    }
    edges.push({
      src_id: enclosing ? enclosing.id : null,
      dst_id: null, dst_name, dst_bare: bareSegment(dst_name), lang, external, member,
      field_key, method, kind, file, line: c.startLine,
    });
  }
  return { nodes, edges, fieldTypes };
}
