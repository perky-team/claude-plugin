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
// A code-unit cut can land inside a surrogate pair (an astral character, like most
// emoji, is stored as two UTF-16 code units). If the kept half ends on a high
// surrogate, its partner just got cut off, so back up one more unit — the whole
// character goes, not half of it. Shared by the signature cap and the callback-name
// cap: a lone half survives a JSON round trip but not a write to SQLite, which
// silently substitutes it, so nothing downstream would report the damage.
const sliceWholeChars = (s, len) => {
  if (s.length <= len) return s;
  const last = s.charCodeAt(len - 1);
  return s.slice(0, last >= 0xD800 && last <= 0xDBFF ? len - 1 : len);
};
const capSignature = (line) => {
  if (line.length <= SIGNATURE_CAP) return line;
  return sliceWholeChars(line, SIGNATURE_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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

// Python's builtin functions and types. `set(xs)`, `len(xs)`, `open(p)` name the
// language, never this repo — the same fact GO_BUILTINS records for Go and
// JS_GLOBALS for TypeScript, and the last of the four languages to get one.
// Measured on httpx: `callers "Cookies.set"` listed `len(set(urls))` and
// `set(params)` as call sites the reader should go and grep for. They are not
// call sites of anything in the repo, and that banner cost the run ten steps
// against grep's five.
//
// A repo may declare its own `def set(...)`, and Python's scoping then makes a
// plain call mean the declaration. That is settled after every file is stored,
// by resolvePyShadowedBuiltins — the same two-step Go uses for `max`.
const PY_BUILTINS = new Set([
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
  'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
  'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help',
  'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list',
  'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open',
  'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set',
  'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple',
  'type', 'vars', 'zip',
]);

// The name a Python annotation writes, or null when it is not a plain name.
//
// Deliberately narrow. `Response` and `"Response"` (a forward reference, which
// is what `from __future__ import annotations` turns every annotation into at
// runtime) are read; `Optional[Response]`, `A | B` and `list[str]` are not.
// Taking the inner type of a subscript is a further step, and recording the
// WRONG type is worse than recording none: a type that leads nowhere makes
// Pass B refuse the bare-name fallback, so a mistake here deletes real rows.
//
// A dotted name is translated through the file's imports exactly as a
// module-qualified call is. `httpx.Response` inside httpx becomes the bare
// `Response` and matches the repo node; `asyncio.Event` keeps its path, which
// no node carries — and that is the point, because the type is not ours.
function pyTypeName(ann, pyModules, pyRepoModules) {
  let n = ann;
  if (n?.type === 'type') n = n.namedChild?.(0) ?? null;
  if (!n) return null;
  if (n.type === 'string') {
    const inner = n.text.replace(/^[a-zA-Z]*['"]{1,3}|['"]{1,3}$/g, '').trim();
    return /^[A-Za-z_][\w.]*$/.test(inner) ? inner : null;
  }
  if (n.type === 'identifier') return n.text;
  if (n.type === 'attribute') {
    const path = pyObjectPath(n.childForFieldName?.('object'));
    const attr = n.childForFieldName?.('attribute');
    if (!path || !attr) return null;
    const modulePath = pyModules.get(path[0]);
    const full = modulePath ? [modulePath, ...path.slice(1)].join('.') : path.join('.');
    return pyRepoModules?.paths.has(full) ? attr.text : `${full}.${attr.text}`;
  }
  return null;
}

// JavaScript's own global objects. `Object.assign(…)`, `JSON.parse(…)`,
// `Reflect.getMetadata(…)` name the language and the runtime, never this repo — the
// same fact GO_BUILTINS above records for Go, which TypeScript had no equivalent of.
// It cost twice over on nest: the bare-name fallback answered `JSON.parse` with a
// repo method called `parse` (71 such guesses, and 61 for `assign`), and every
// unmatched one landed in the gap banner of whatever repo method shares the name —
// 126 `Object.create` rows sat in the banner of `PipesContextCreator.create`.
//
// Only the standard objects and the Node globals are listed, never a library: a
// name that arrives through an import is a fact about this repo's dependencies, not
// about the language. A repo that declares its own class of one of these names wins
// anyway — see resolveTsStaticCalls, which is allowed to resolve an external edge
// for exactly the reason Go's resolveShadowedBuiltins is.
const JS_GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function',
  'Math', 'JSON', 'Date', 'RegExp', 'Promise', 'Proxy', 'Reflect', 'Intl',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError',
  'URIError', 'AggregateError',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
  'globalThis', 'console', 'process', 'Buffer', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'performance',
]);

// A TypeScript declaration file states an API, it does not define one. axios
// publishes `index.d.ts` and `index.d.cts`, and between them they restate every
// public method of `lib/` under a qname of their own — `AxiosInterceptorManager.eject`
// for `InterceptorManager.eject`. Counted as definitions, those twins made 18 bare
// names in axios ambiguous, which is what stopped the bare-name fallback from
// answering `eject` at all. A C++ header already yields to its definition; this is
// the same rule for the same reason.
//
// Case-insensitive, because the language resolver is: parse/index.mjs lowercases
// the extension before it picks TypeScript, so `Index.D.TS` is indexed as
// TypeScript. Without the `i` flag that file would be read as code that DEFINES
// the API, and its nodes would compete with the real ones.
const TS_DECL_FILE = /\.d\.(c|m)?ts$/i;

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
// The type a TypeScript def declares as its result. Go has read this since the
// start and Python since the round before; all three TypeScript graphs in the
// study held zero such rows, in the language that writes a return type most.
//
// `Promise<Foo>` is unwrapped to Foo. An async function is annotated that way
// and the value every caller uses is the awaited one; a Promise's own methods
// are `then` and `catch`, which no repo class answers, so the unwrap cannot
// cost a real row. It can be wrong only for code that calls a Foo method on an
// un-awaited promise, which does not run.
//
// A union, an inline object type and anything else that names no single type
// are refused, for the reason the whole file repeats: a wrong type deletes real
// rows, because Pass B stops guessing once a type is recorded.
function tsReturnTypeName(node) {
  let fn = node;
  if (fn && !/function|method_definition|method_signature/.test(fn.type)) {
    fn = findChild(fn, (n) => /^(arrow_function|function_expression|function_declaration)$/.test(n.type)) ?? fn;
  }
  const ann = fn?.childForFieldName?.('return_type');
  let t = ann?.type === 'type_annotation' ? ann.namedChild(0) : ann;
  if (t?.type === 'generic_type') {
    const base = t.childForFieldName?.('name');
    if (base?.text === 'Promise' || base?.text === 'Awaited') {
      t = t.childForFieldName?.('type_arguments')?.namedChild(0) ?? null;
    }
  }
  if (!t) return null;
  if (t.type === 'type_identifier') return t.text;
  if (t.type === 'nested_type_identifier') return t.text.replace(/\s/g, '');
  if (t.type === 'generic_type') {
    const base = t.childForFieldName?.('name');
    if (base?.type === 'type_identifier') return base.text;
    if (base?.type === 'nested_type_identifier') return base.text.replace(/\s/g, '');
  }
  return null;
}

// The first descendant matching a predicate, breadth-first and shallow — used
// to find the function inside a declaration that wraps one.
function findChild(node, pred, depth = 3) {
  if (!node || depth < 0) return null;
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (pred(c)) return c;
    const deeper = findChild(c, pred, depth - 1);
    if (deeper) return deeper;
  }
  return null;
}

function tsStatedTypeName(declNode, ownerClass = null) {
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
  //
  // `const request = firstRequest ?? new Request(...)` names it just as plainly,
  // and that is the shape got writes: whichever branch runs, the value is a
  // Request. Only `??` and `||` count, and only when exactly one operand
  // constructs — two different constructors name two types, and picking one
  // would be a guess wearing knowledge's clothes.
  const value = declNode?.childForFieldName?.('value');
  const ctorOf = (n) => {
    if (n?.type !== 'new_expression') return null;
    const ctor = n.childForFieldName?.('constructor');
    return ctor?.type === 'identifier' ? ctor.text : null;
  };
  const direct = ctorOf(value);
  if (direct) return named(direct);
  if (value?.type === 'binary_expression' && ['??', '||'].includes(value.childForFieldName?.('operator')?.text ?? '')) {
    const left = value.childForFieldName?.('left');
    const right = value.childForFieldName?.('right');
    // The side that does NOT construct has to be a plain name or an empty
    // value. `a ?? new A()` means "a if it has one, else a fresh A", so `a` is
    // an A — that is the language's own contract. Anything else on that side —
    // a ternary, a call, another constructor — can be a different type, and
    // then naming one of them would be a guess dressed as knowledge.
    const plain = (n) => ['identifier', 'null', 'undefined', 'member_expression'].includes(n?.type ?? '');
    const ctorLeft = ctorOf(left); const ctorRight = ctorOf(right);
    if (ctorRight && !ctorLeft && plain(left)) return named(ctorRight);
    if (ctorLeft && !ctorRight && plain(right)) return named(ctorLeft);
  }
  // `const s = make()` and `const s = await this.build()`. What the value IS
  // depends on what the callee returns, which is a fact recorded separately
  // under "<qname>#ret" — the same two-step Go and Python use. Only a bare name
  // and a call on `this` are read: anything else needs to know what the
  // receiver holds first, and that is a different question.
  let call = value;
  if (call?.type === 'await_expression') call = call.namedChild?.(0) ?? call;
  if (call?.type === 'call_expression') {
    const fn = call.childForFieldName?.('function');
    if (fn?.type === 'identifier') return `#ret:${fn.text}`;
    if (fn?.type === 'member_expression' && fn.childForFieldName?.('object')?.type === 'this'
        && ownerClass) {
      const prop = fn.childForFieldName?.('property')?.text;
      if (prop) return `#ret:${ownerClass}.${prop}`;
    }
  }
  return null;
}

// The type a TypeScript alias points at: `type ProducerSerializer = Serializer<…>`
// gives "Serializer". Only a name counts — a union, an object type or a mapped type
// names no single type, and a field declared with one of those has no type this
// reader can follow.
function tsAliasTargetName(aliasNode) {
  const v = aliasNode?.childForFieldName?.('value');
  if (v?.type === 'type_identifier') return v.text;
  if (v?.type === 'nested_type_identifier') return v.text.replace(/\s/g, '').split('.').pop();
  if (v?.type === 'generic_type') {
    const base = v.childForFieldName?.('name');
    if (base?.type === 'type_identifier') return base.text;
    if (base?.type === 'nested_type_identifier') return base.text.replace(/\s/g, '').split('.').pop();
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
      // `nextCopy := next` — one name copied into another. Nothing at the second
      // name says what it holds, but the first one does, and Go reads it that way.
      // The name is returned rather than a type, because what it holds depends on
      // which binding is in scope HERE, and that is only known once every binding
      // in the file has been recorded.
      const alias = !t && init?.type === 'identifier' ? init : null;
      out.push({ nameNode: name, typeNode: t, aliasNode: alias,
        callNode: t || alias ? null : (init ? goInitCallNode(init) : null) });
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

// The names parked in an ERROR node inside a qualified_identifier, or [] if there
// is no ERROR there.
//
// WHY. A header-only C++ library writes every out-of-class definition behind a
// macro: `SPDLOG_INLINE std::shared_ptr<logger> registry::get(...)`. tree-sitter
// does not know the macro, so it reads it as the return type, and then the real
// return type has nowhere to go — it takes the scope slot, and the class that owns
// the method is pushed into an ERROR node:
//
//   qualified_identifier [scope=«std» name=qualified_identifier]
//     qualified_identifier [scope=«shared_ptr<logger>» name=«get»]
//       ERROR
//         identifier «registry»          <- the owner, the only true scope here
//
// Measured on spdlog: 337 of 1323 methods came out named after their return type,
// `std.shared_ptr.registry.get` and the like, and `callers "registry.get"` answered
// with no callers at all and a warning listing every one of the 33. leveldb and re2
// do not use the macro style and were untouched, which is why this went unseen.
function cppErrorScopes(n) {
  const out = [];
  for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
    const c = n.namedChild(i);
    if (c?.type !== 'ERROR') continue;
    for (let j = 0; j < (c.namedChildCount ?? 0); j++) {
      const g = c.namedChild(j);
      if (!g) continue;
      if (g.type === 'template_type') out.push(g.childForFieldName?.('name')?.text ?? g.text);
      else if (/identifier$/.test(g.type)) out.push(g.text);
    }
  }
  return out;
}

function cppNamePath(declarator) {
  let path = [];
  let n = declarator;
  while (n?.type === 'qualified_identifier') {
    // An ERROR here means everything collected so far is the return type, not a
    // scope. Start again from the names the ERROR holds — they are the real owner.
    const owner = cppErrorScopes(n);
    if (owner.length) path = owner;
    else {
      const scope = n.childForFieldName?.('scope');
      const name = n.childForFieldName?.('name');
      // Only `::` joins a scope to what follows it. When the source puts a SPACE
      // there, tree-sitter has read a return type as a scope and everything so far
      // belongs to the return type, so start again:
      //   `SPDLOG_INLINE std::shared_ptr<logger> registry::get(…)`
      //                  ^^^^^^^^^^^^^^^^^^^^^^^ scope, scope   ^^^^^^^^ the owner
      // The same source parses two ways depending on how long the class name is —
      // a short one leaves an ERROR node (handled above), a long one leaves none —
      // so both checks are needed.
      if (scope) {
        const sep = (typeof scope.endIndex === 'number' && typeof name?.startIndex === 'number')
          ? n.text.slice(scope.endIndex - n.startIndex, name.startIndex - n.startIndex).trim()
          : '::';
        if (sep !== '::') path = [];
        // `Vec<T>::At` — the scope is the template, and the class is its `name`.
        else path.push(scope.type === 'template_type'
          ? (scope.childForFieldName?.('name')?.text ?? scope.text) : scope.text);
      }
    }
    n = n.childForFieldName?.('name');
  }
  // `template <> void f<int>() {}` — the name sits under the specialization.
  if (n?.type === 'template_function') n = n.childForFieldName?.('name');
  if (!n || !CPP_NAME_NODES.includes(n.type)) return null;
  path.push(n.text);
  return path;
}

// The name a googletest body should carry: `TEST(WriteBatchTest, Empty) { … }`
// becomes `WriteBatchTest.Empty`. Returns null for anything that is not one of
// these macros, and then the definition keeps the name it had.
//
// WHY. tree-sitter reads the macro as a function definition called `TEST`, and
// the two arguments as parameters. Measured on leveldb, 139 definitions ended up
// sharing the qname `leveldb.TEST_F` and 47 shared `leveldb.TEST`. That costs
// twice over: a reader gets gap lines and caller rows reading
// `leveldb.TEST_F -> Put` again and again with no way to tell the tests apart,
// and an exact-qname lookup for any one of them is ambiguous, so it answers with
// none of them.
//
// The macro list is explicit on purpose. Reading two arguments out of a macro we
// do not know would invent a name, and a wrong name is worse than a dull one.
// googletest is where all of these come from, and it spells them the same way in
// every project.
const GTEST_MACROS = new Set(['TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P']);
function cppGtestPath(path, declarator) {
  if (path.length !== 1 || !GTEST_MACROS.has(path[0])) return null;
  const params = declarator?.childForFieldName?.('parameters');
  if (!params || params.namedChildCount !== 2) return null;
  // The arguments are bare names, so tree-sitter reads each as a parameter whose
  // TYPE is a type_identifier and which declares nothing. A real function called
  // TEST — `int TEST(int a, int b)` — names a declarator in each parameter, which
  // is what tells the two apart.
  const names = [];
  for (let i = 0; i < 2; i++) {
    const p = params.namedChild(i);
    if (p?.type !== 'parameter_declaration' || p.childForFieldName?.('declarator')) return null;
    const t = p.childForFieldName?.('type');
    if (t?.type !== 'type_identifier') return null;
    names.push(t.text);
  }
  return names.join('.');
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

// The pure virtuals written inside a class body the parse could not keep.
//
// `class LEVELDB_EXPORT Cache { virtual bool Insert(…) = 0; … };` — the macro
// between `class` and the name breaks the parse, the body becomes a
// compound_statement, and an ERROR node swallows every pure virtual after the
// first. Measured on leveldb: 1 of 7 in cache.h, 1 of 9 in iterator.h, 1 of 10 in
// db.h. Every public class in that repo is written this way, so a query-based rule
// reaches almost none of them — and recovering one interface method while leaving
// its six siblings out is worse than recovering none, because the reader cannot
// tell which case they have.
//
// So read them from the source, as cppMacroClassName already reads the class name.
// `virtual … <name>(…) … = 0;` is unambiguous in C++: `virtual` and `= 0` in one
// statement is a pure virtual and nothing else. Returns {name, line, col} for each.
const CPP_PURE_VIRTUAL =
  /\bvirtual\b[^;{}()]*?\b([A-Za-z_]\w*)\s*\([^;{}]*?\)[^;{}]*?=\s*0\s*;/g;
function cppMacroPureVirtuals(node, source) {
  const body = source.slice(node.startIndex, node.endIndex);
  const out = [];
  for (const m of body.matchAll(CPP_PURE_VIRTUAL)) {
    // The name's own offset inside the whole file, so the synthesised definition
    // sits where the source puts it and containment reads it as the class's child.
    const at = node.startIndex + m.index + m[0].indexOf(m[1]);
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    out.push({ name: m[1], line, col: at - (before.lastIndexOf('\n') + 1) });
  }
  return out;
}

// The scopes a C++ name can be bound in. A block is a scope of its own, which is
// what keeps `if (f) { Batch b; … } else { Other b; … }` from typing one branch
// with the other's variable. Missing a node type here makes a scope too WIDE,
// which keeps today's answer instead of inventing one — the same trade the Go and
// TypeScript sets make.
// Thread-safety annotations from clang's analysis attributes, as every Google C++
// project spells them. Written after the parameter list, where they break the parse
// in two — see the check in the definition loop.
const CPP_ANNOTATION_MACROS = new Set([
  'LOCKS_EXCLUDED', 'EXCLUSIVE_LOCKS_REQUIRED', 'SHARED_LOCKS_REQUIRED',
  'EXCLUSIVE_LOCK_FUNCTION', 'SHARED_LOCK_FUNCTION', 'UNLOCK_FUNCTION',
  'ACQUIRED_AFTER', 'ACQUIRED_BEFORE', 'GUARDED_BY', 'PT_GUARDED_BY',
  'ABSL_LOCKS_EXCLUDED', 'ABSL_EXCLUSIVE_LOCKS_REQUIRED', 'ABSL_GUARDED_BY',
]);

const CPP_SCOPE_NODES = new Set([
  'compound_statement', 'function_definition', 'for_statement', 'for_range_loop',
  'while_statement', 'if_statement', 'switch_statement', 'catch_clause',
  'field_declaration_list', 'namespace_definition', 'translation_unit',
]);

// The type a C++ declaration writes, as a dotted name, or null when it writes
// nothing a lookup can use. `db::Batch` becomes `db.Batch` so it reads like a
// qname; `std::vector<int>` becomes `std.vector`, because the template arguments
// name no type the graph holds. `auto` is deliberately null: it states that the
// type is written somewhere else.
const CPP_TYPE_NODES = new Set([
  'type_identifier', 'qualified_identifier', 'template_type', 'primitive_type',
  'sized_type_specifier',
]);
function cppWrittenType(decl) {
  let t = decl?.childForFieldName?.('type');
  if (!t) return null;
  // `using T = Skip<int>;` wraps the type in a type_descriptor; `typedef` does not.
  if (t.type === 'type_descriptor') t = t.childForFieldName?.('type') ?? t.namedChild(0) ?? t;
  if (t.type === 'template_type') t = t.childForFieldName?.('name') ?? t;
  if (!CPP_TYPE_NODES.has(t.type)) return null;
  return t.text.replace(/::/g, '.');
}

// The names a C++ declaration declares, with the node each name sits on. Walks
// past every declarator wrapper — pointer, reference, array, initialiser,
// function — so `Batch* b = Make()` and `const Batch& b` both give `b`.
//
// A function declarator is skipped on purpose: `void Batch::Put(int k);` declares
// a method, not a variable of type void, and recording `Put` as a name of type
// `void` would make every `Put.something()` resolve to nothing.
function cppDeclaredNames(decl, inFunctionBody = false) {
  const out = [];
  const walk = (n, depth) => {
    if (!n || depth > 8) return;
    switch (n.type) {
      case 'identifier':
      case 'field_identifier':
        out.push(n);
        return;
      case 'function_declarator':
        // C++'s "most vexing parse". `Batch b(Opts());` inside a function body is a
        // variable built with constructor arguments, and it is spelled exactly like
        // a function declaration — tree-sitter reads it as one. It is the everyday
        // way to build an object, so inside a BODY the name is taken as a variable.
        // Measured on leveldb: this is why `model.Put(…)` at db_test.cc:2310 could
        // not be placed.
        //
        // Only inside a body. At class or file scope `T name(A a);` is a declaration
        // and nothing else, and reading it as a variable would put a method's name
        // in the variable table. Getting the body case wrong costs nothing: the
        // recorded type leads to a `<T>.<method>` lookup that simply finds nothing.
        if (inFunctionBody) walk(n.childForFieldName?.('declarator'), depth + 1);
        return;
      case 'pointer_declarator':
      case 'reference_declarator':
      case 'array_declarator':
      case 'init_declarator':
      case 'parenthesized_declarator':
        walk(n.childForFieldName?.('declarator') ?? n.namedChild(0), depth + 1);
        return;
      default:
        return;
    }
  };
  // A declaration can declare several names: `Batch a, b;` holds two declarators.
  for (let i = 0; i < decl.namedChildCount; i++) {
    const c = decl.namedChild(i);
    if (c === decl.childForFieldName?.('type')) continue;
    walk(c, 0);
  }
  return out;
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
// Does a JS/TS definition keep the `this` of the scope around it? An arrow
// function does; `function () {}`, a generator and a method each get their own.
// A definition captured through a WRAPPER — `const f = (x) => …` anchors on the
// lexical_declaration, a field on the field definition — is an arrow by
// construction: every wrapping capture in ts.scm and js.scm requires an
// `(arrow_function)` child, so there is no other shape to tell apart.
const JS_OWN_THIS = new Set([
  'function_expression', 'generator_function', 'function_declaration',
  'method_definition', 'class_declaration', 'class',
]);
function jsKeepsOuterThis(def) {
  const t = def?.node?.type;
  if (!t) return false;
  if (t === 'arrow_function') return true;
  return !JS_OWN_THIS.has(t);
}

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
  // Between the call and the definition that owns it there may be a `function`
  // expression that no capture turned into a definition of its own — a callback
  // inside a named method is deliberately attributed to the method. That is
  // right for the caller, and wrong for `this`: a plain `function` gets its own.
  // Reading the nodes in between is the only place that can be seen.
  if (lang === 'ts' || lang === 'js') {
    // Compare positions, not objects: every parent walk hands back a fresh
    // wrapper for the same node, so `!==` would always be true.
    const en = enclosing.node;
    for (let n = c.node?.parent; n; n = n.parent) {
      if (en && n.startIndex === en.startIndex && n.endIndex === en.endIndex) break;
      if (JS_OWN_THIS.has(n.type) && n.type !== 'class_declaration' && n.type !== 'class') return null;
    }
  }
  // Walk out until a type is reached. One level is the ordinary case — the call
  // is in a method and the method's container is the class — but a call written
  // inside a CLOSURE inside a method is one level deeper, and stopping there
  // dropped it to a bare-name guess. Measured on got: `Request._onRequest`'s
  // error handler is an arrow function holding `this._beforeError(...)`.
  //
  // Which closures pass `this` through is a language rule, not a guess:
  //   - an arrow function does not rebind `this`; a plain `function` does, so a
  //     walk through one would claim a class the call may never see.
  //   - a nested `def` in Python closes over the enclosing `self`, so any
  //     function-like container is fine there.
  // C++ is left alone: whether a lambda has `this` depends on its capture list.
  let node = enclosing;
  for (let hops = 0; node && hops < 8; hops++) {
    const up = defs.find((d) => d.id === node.container_id);
    if (!up) return null;
    if (OWNER_KINDS.has(up.kind)) return up;
    if (lang === 'py') { node = up; continue; }
    if ((lang === 'ts' || lang === 'js') && jsKeepsOuterThis(node)) { node = up; continue; }
    return null;
  }
  return null;
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

// The name a call was written on: the whole dotted path when every part of it is a
// plain name (`describe`, `describe.skip`, `app.get`, `this.server.close`), else just
// the method that was called (`map` out of `[1].map(…)`, `catch` out of a promise
// chain). Null only when there is no name anywhere — then the caller falls back to
// the line alone.
//
// The WHOLE path matters, not only the last part: `describe.skip('x', …)` read as its
// last part gives `skip:x`, which reads as a suite named "skip", and the same mistake
// turns `it.only` into `only:` and `test.each` into `each:`. All three are everyday
// test shapes. But falling back to nothing when the head is not a plain name is worse
// than the last part: `promise.then(…).catch(…)` would lose `catch` and two callbacks
// on one line would end up with the same name. Capped, because a receiver chain can
// be long.
function calleePath(fn) {
  const parts = [];
  let n = fn;
  while (n?.type === 'member_expression') {
    const prop = n.childForFieldName?.('property');
    if (prop?.type !== 'property_identifier') break;
    parts.unshift(prop.text);
    n = n.childForFieldName?.('object');
  }
  const head = n?.type === 'this' ? 'this' : n?.type === 'identifier' ? n.text : null;
  if (!parts.length) return head;               // a plain `describe(…)`, or nothing
  if (head === null) return parts[parts.length - 1];   // the method, without its receiver
  const path = [head, ...parts].join('.');
  return path.length > 60 ? parts[parts.length - 1] : path;
}

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
// which is harmless — the node id carries an `ord` that separates them. The cut goes
// through sliceWholeChars, so an emoji at the cap loses the whole character instead
// of half of it.
const CALLBACK_LABEL_CAP = 80;
function callbackDefName(cb) {
  const args = cb.parent;                       // (arguments …)
  const call = args?.parent;                    // (call_expression …)
  let fn = call?.childForFieldName?.('function');
  // `it.runIf(cond)('case', …)` calls the RESULT of a call, so the name of the
  // thing being called has to be read one level in.
  while (fn?.type === 'call_expression') fn = fn.childForFieldName?.('function');
  const callee = calleePath(fn);
  const first = args?.namedChild?.(0);
  const label = first && (first.type === 'string' || first.type === 'template_string')
    ? sliceWholeChars(first.text.slice(1, -1).replace(/\s+/g, ' ').trim(), CALLBACK_LABEL_CAP)
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
  // Every name a plain `import` binds, repo or not. pyModules above keeps only
  // this repo's modules, on purpose — a call qualified by a library module is
  // not a repo call. But `x = asyncio.Event()` needs the other half of that
  // fact: the head IS a module, so the value comes from outside the repo and
  // the gap report can count the row instead of listing it.
  const pyLibModules = lang === 'py'
    ? new Set([...pyModuleNames(caps, null, pyOwnPkg).keys()]
      .filter((n) => !pyModules.has(n))) : null;

  const defKinds = ['function', 'method', 'class', 'struct', 'interface', 'type', 'enum', 'namespace'];
  const defs = [];
  // Definitions the parse could not produce, synthesised from the source: the pure
  // virtuals of a macro-broken class body. Collected here and appended after the
  // capture loop, so they take part in dedup, nesting and qname building exactly
  // like a captured definition.
  const macroMembers = [];
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
      localPath = cppGtestPath(path, fd) ?? path.join('.');
    }
    // A class whose name a macro pushed out of the parse. The captured node is
    // the broken function definition or declaration, not a class_specifier, and
    // the name has to be read from the source — see cppMacroClassName.
    // A DECLARATION, not a definition: a C++ pure virtual. It earns a node because
    // an interface method has no definition to index — but it yields to a real
    // definition when the repo has one, because C++ lets a pure virtual have a body
    // and two nodes on one qname resolve to neither. See SCHEMA_VERSION 9.
    let decl = lang === 'cpp' && d.node?.type === 'field_declaration';
    // A thread-safety annotation after the parameter list splits the parse: the real
    // name stays in the declaration above and the BODY becomes a definition named
    // after the macro. The declaration is now indexed (see cpp.scm), so the bogus
    // definition is simply dropped — a wrong name is worse than a missing one,
    // because search finds it and a reader believes it.
    if (lang === 'cpp' && kind === 'function' && d.node?.type === 'function_definition') {
      const fd0 = cppFunctionDeclarator(d.node.childForFieldName?.('declarator'));
      const nm = fd0 && cppNamePath(fd0.childForFieldName?.('declarator'));
      if (nm?.length === 1 && CPP_ANNOTATION_MACROS.has(nm[0])) continue;
    }
    let macroClass = false;
    if (lang === 'cpp' && (kind === 'class' || kind === 'struct') &&
        d.node.type !== 'class_specifier' && d.node.type !== 'struct_specifier') {
      const recovered = cppMacroClassName(d.node, source);
      if (!recovered) continue; // too broken to name — a wrong owner is worse
      localPath = recovered;
      macroClass = true;
      // The interface methods the broken parse lost. Pushed as definitions of
      // their own so nesting gives them `<ns>.<Class>.<name>` like any other
      // method — see cppMacroPureVirtuals.
      for (const pv of cppMacroPureVirtuals(d.node, source)) {
        macroMembers.push({
          kind: 'method', localPath: null, isCallback: false,
          macroClass: false, decl: true, name: pv.name,
          startLine: pv.line, endLine: pv.line,
          startCol: pv.col, endCol: pv.col + pv.name.length,
          signature: capSignature(source.split('\n')[pv.line - 1]?.trim() ?? ''),
          node: null,
        });
      }
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
      kind, localPath, isCallback, macroClass, decl,
      name: localPath ? localPath.slice(localPath.lastIndexOf('.') + 1)
        : (ownName ?? nameCap?.text ?? '(anon)'),
      startLine: d.startLine, endLine: d.endLine,
      startCol: d.startCol, endCol: d.endCol,
      signature: capSignature(source.split('\n')[d.startLine - 1]?.trim() ?? ''),
      node: d.node, // kept for containment checks below; never copied into `nodes`
    });
  }

  defs.push(...macroMembers);

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
    // The nearest enclosing definition that is NOT a callback, this one included.
    // Always set before any child of this def is reached, because defs are sorted
    // outermost first.
    def.nonCallbackAncestor = def.isCallback ? (parent?.nonCallbackAncestor ?? null) : def;
    // A callback is not a namespace. It qualifies a nested callback — so a test
    // reads `describe:suite.it:case` — but it must NOT qualify a real declaration
    // written inside it. A qname that moves changes which names look unique, and
    // Pass A calls a unique bare qname CERTAIN: measured on this repo, moving one
    // test helper under its `describe` left a second one unique and produced three
    // false certain rows pointing at an unrelated test file. So a declaration keeps
    // exactly the qname it had before this feature existed.
    const qnameParent = def.isCallback ? parent : (parent?.nonCallbackAncestor ?? null);
    // C++ writes the owner into the declarator (`PgStore::Get`), so the
    // definition names its own path and nesting only adds what encloses it.
    const local = def.localPath ?? def.name;
    if (qnameParent) {
      // Nesting already carries any package prefix through the parent's qname.
      def.qname = `${qnameParent.qname}.${local}`;
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

  const declFile = TS_DECL_FILE.test(file);
  const nodes = defs.map((d) => ({
    id: d.id, name: d.name, qname: d.qname, kind: d.kind, lang,
    file, start_line: d.startLine, end_line: d.endLine,
    signature: d.signature, doc: '', container_id: d.container_id,
    decl: (d.decl || declFile) ? 1 : 0,
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
  const bindings = new Map();
  // `x := y` in Go: the copy's type is whatever binding `y` refers to at that line,
  // which is only settled once every binding in the file is recorded and sorted. So
  // the pairs are collected here and resolved after bindingAt below.
  const goCopies = []; // [{ key of the copy, the name node it was copied from }, ...]
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
      if (nameNode.text === '_') return null;
      const owner = ownerOf(cap);
      const scope = goScopeNode(nameNode);
      if (!scope) return null;
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
      if (!key) return null; // a package-level name in a file with no package clause
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
      if (!typeName) return key;
      // A "#ret:" row names a callee, not a type, so it must not be offered as
      // one: `x.f.M()` keys on the type that owns the field `f`, and there is no
      // such type here.
      if (typeName.startsWith('#ret:')) { fieldTypes.push({ key, type: typeName, file }); return key; }
      fieldTypes.push({ key, type: typeName, file });
      // One key is one binding, so a second type for it can only come from two
      // query patterns matching the same declaration. Refuse rather than pick.
      varTypes.set(key, varTypes.has(key) && varTypes.get(key) !== typeName ? null : typeName);
      return key;
    };
    // `x := y` waits for the second pass further down: what `y` holds depends on
    // the binding in scope at that line, and that is only settled once every
    // binding in the file is recorded and sorted.
    for (const vd of caps.filter((c) => c.name === 'var.decl')) {
      for (const { nameNode, typeNode, aliasNode, callNode } of goVarDeclNames(vd.node)) {
        const key = bind(vd, nameNode, typeNode, vd.node, callNode);
        if (aliasNode && key) goCopies.push({ key, aliasNode });
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

  // Give each copied name the type of the binding its source name refers to.
  // `#ret:` rows are not carried over: a marker says the type is decided somewhere
  // this reader cannot see, and copying that claim one step further adds nothing.
  // A copy of a copy is not followed either — one hop covers the shape this exists
  // for (`nextCopy := next`), and a chain risks a cycle.
  for (const { key, aliasNode } of goCopies) {
    const src = bindingAt(aliasNode.text, aliasNode);
    const type = src ? varTypes.get(src.key) : null;
    if (!type || type.startsWith('#ret:')) continue;
    fieldTypes.push({ key, type, file });
    varTypes.set(key, varTypes.has(key) && varTypes.get(key) !== type ? null : type);
  }

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
    // same to a parser: a name bound to the result of a call. Record what the
    // call produces under the name's key, exactly as Go does for
    // `x := pkg.Make()`. The resolver then finds the repo class and answers
    // certainly, or finds nothing — and a call on that name is refused instead
    // of guessing the one repo method that shares its bare name. Those guesses
    // were 39 false rows on psf/requests.
    //
    // The result is one of two shapes, and which one matters:
    //   "#ret:<callee>" — ask the resolver what that callee returns.
    //   a plain dotted name — `asyncio.Event()` is a call into an IMPORTED
    //     module, so the value comes from outside the repo whatever the callee
    //     is. Written as a type rather than a marker, so the gap report can say
    //     so and count the row instead of listing it.
    // Does a local or a parameter shadow this name here? The same question
    // pyNamesAValue answers for the call loop further down; asked here too
    // because that one is declared later and would still be in its dead zone.
    const pyBindsAValue = (name, node) => {
      const line = node.startPosition.row + 1, col = node.startPosition.column;
      return (pyValueNames.get(name) ?? []).some((s) =>
        posLE(s.startLine, s.startCol, line, col) && posLE(line, col, s.endLine, s.endCol));
    };

    const pyBoundType = (value, boundName) => {
      let v = value;
      // `r = await client.send(...)` puts an `await` node on the right, not a
      // `call`, so nothing at all used to be recorded for r. httpx writes 70
      // bindings that way, and four of them are the call sites missing from
      // `callers "Response.raise_for_status"`.
      if (v?.type === 'await') v = v.namedChild?.(0) ?? v;
      if (v?.type !== 'call') return null;
      const fn = v.childForFieldName?.('function');
      if (!fn) return null;
      if (fn.type === 'identifier') {
        // `q = q.set(...)` — a row saying "q is whatever q.set returns" can
        // only be worked out from q's type, the very thing it is meant to
        // supply. It never resolves, and a second row for one key is read as a
        // conflict, so it silently deletes the type the first binding stated.
        return fn.text === boundName ? null : `#ret:${fn.text}`;
      }
      if (fn.type !== 'attribute') return null;
      // `mod.Cls()`: the head is translated through this file's imports, the
      // same way a module-qualified CALL is. A repo module leaves the class
      // reachable by its own (bare) qname.
      const path = pyObjectPath(fn.childForFieldName?.('object'));
      const attr = fn.childForFieldName?.('attribute');
      if (!path || !attr) return null;
      const modulePath = pyModules.get(path[0]);
      const full = modulePath ? [modulePath, ...path.slice(1)].join('.') : path.join('.');
      if (pyRepoModules?.paths.has(full)) return `#ret:${attr.text}`;
      // `asyncio.Event()` — the head names an imported library module, so the
      // value is not this repo's whatever the callee does. Recorded as a type
      // rather than a marker, which is what lets the gap report say so.
      if (pyLibModules.has(path[0]) && !pyBindsAValue(path[0], fn)) return `${full}.${attr.text}`;
      if (path[0] === boundName) return null; // circular, as above
      return `#ret:${full}.${attr.text}`; // a call on a value — the head is not a module
    };

    for (const c of caps) {
      if (c.name !== 'var.local') continue;
      const assign = c.node?.parent;
      if (assign?.type !== 'assignment') continue;
      // Compare positions, not objects: every childForFieldName call hands back a
      // fresh wrapper for the same node, so `!==` is always true.
      const left = assign.childForFieldName?.('left');
      if (!left || left.startIndex !== c.node.startIndex) continue; // not a plain `x = …`
      // `r: Response = client.send()` states the type outright. The loop below
      // records it, and a second row saying "whatever client.send returns"
      // would make two types for one key — which every pass reads as a
      // conflict and refuses. The written type wins.
      if (assign.childForFieldName?.('type')) continue;
      const type = pyBoundType(assign.childForFieldName?.('right'), c.text);
      if (!type) continue;
      // The key is built exactly as the binding loop above builds it, so a row and
      // the call site that reads it cannot drift apart.
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      fieldTypes.push({
        key: owner ? `${owner.id}#var:${c.text}` : `${file}#var:${c.text}`,
        type, file,
      });
    }

    // `with httpx.Client() as client:` — how httpx's own tests open a client,
    // and every call on `client` afterwards hangs off that binding. The `with`
    // protocol hands back what `__enter__` returns, and the convention every
    // client, session and connection in these repos follows is to return
    // itself; httpx writes it out as `def __enter__(self: T) -> T`. So the
    // value is what the expression constructs.
    for (const c of caps) {
      if (c.name !== 'var.local') continue;
      const target = c.node?.parent;
      if (target?.type !== 'as_pattern_target') continue;
      const as = target.parent;
      if (as?.type !== 'as_pattern') continue;
      const type = pyBoundType(as.namedChild?.(0), c.text);
      if (!type) continue;
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      fieldTypes.push({
        key: owner ? `${owner.id}#var:${c.text}` : `${file}#var:${c.text}`,
        type, file,
      });
    }

    // The type the source WRITES. Python was the only supported language whose
    // annotations p-graph never read: the whole of `field_types` for a Python
    // repo was the `x = Call()` rows above. Measured on three repositories,
    // member calls resolved with certainty were 5.8% on flask, 17.4% on
    // requests and 20.8% on httpx.
    //
    // Three places carry a type, and all three land under the SAME key the
    // binding loop built, so Pass F answers them with no new pass:
    //   `def f(r: Response)`     — typed_parameter / typed_default_parameter
    //   `r: Response = client()` — an assignment with a type field
    // and the third, a def's `-> T`, goes under "<qname>#ret" for Pass R.
    for (const c of caps) {
      if (c.name !== 'var.local') continue;
      const p = c.node?.parent;
      let ann = null;
      if (p?.type === 'typed_parameter' || p?.type === 'typed_default_parameter') {
        ann = p.childForFieldName?.('type');
      } else if (p?.type === 'assignment') {
        const left = p.childForFieldName?.('left');
        if (left && left.startIndex === c.node.startIndex) ann = p.childForFieldName?.('type');
      }
      const type = pyTypeName(ann, pyModules, pyRepoModules);
      if (!type) continue;
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      fieldTypes.push({
        key: owner ? `${owner.id}#var:${c.text}` : `${file}#var:${c.text}`,
        type, file,
      });
    }

    // `def fetch() -> Response:` — the same row shape Go has written for
    // months, so Pass R follows `#ret:fetch` to it with nothing new added.
    for (const d of defs) {
      if (d.kind !== 'function' && d.kind !== 'method') continue;
      const type = pyTypeName(d.node?.childForFieldName?.('return_type'), pyModules, pyRepoModules);
      if (type) fieldTypes.push({ key: `${d.qname}#ret`, type, file });
    }

    // What a class field holds, for the `self.<field>.<method>()` calls keyed
    // above. Both key shapes are written, exactly as TypeScript does it: the
    // call site uses the file-qualified one, and the bare one is the fallback.
    const pushField = (cls, name, type) => {
      if (!cls || !name || !type) return;
      fieldTypes.push({ key: `${cls.name}#field:${name}`, type, file });
      fieldTypes.push({ key: `${file}|${cls.name}#field:${name}`, type, file });
    };
    const enclosingClass = (n) => defs
      .filter((d) => d.kind === 'class' && d.node && n.startIndex >= d.node.startIndex
        && n.endIndex <= d.node.endIndex)
      .sort((a, b) => (b.node.startIndex - a.node.startIndex))[0];

    // `self.jar = Cookies()` and `self.jar: Cookies = jar`. The name on the left
    // is an attribute, not a binding, so no capture ever pointed at it — the
    // class body is walked directly instead. One walk per class, and a class
    // body is small; the query file stays as it is, because every extra pattern
    // there is matched against every node of every Python file and that is what
    // made indexing flask twice as slow once already.
    const selfAssign = (cls, n) => {
      if (!n) return;
      if (n.type === 'assignment') {
        const left = n.childForFieldName?.('left');
        if (left?.type === 'attribute' &&
            ['self', 'cls'].includes(left.childForFieldName?.('object')?.text ?? '')) {
          const name = left.childForFieldName?.('attribute')?.text;
          const written = pyTypeName(n.childForFieldName?.('type'), pyModules, pyRepoModules);
          // No annotation: fall back to what the right-hand side constructs,
          // read exactly as a local binding is.
          pushField(cls, name, written ?? pyBoundType(n.childForFieldName?.('right'), name));
        }
      }
      for (let i = 0; i < (n.namedChildCount ?? 0); i++) selfAssign(cls, n.namedChild(i));
    };
    for (const d of defs) if (d.kind === 'class' && d.node) selfAssign(d, d.node);

    for (const d of defs) {
      // A name annotated in a class body — `jar: Cookies` — is a field, not a
      // local. The annotation loop above keyed it on the class definition that
      // holds it, which nothing reads; this is the key the call site uses.
      if (d.kind !== 'class' || !d.node) continue;
      const body = d.node.childForFieldName?.('body');
      for (let i = 0; i < (body?.namedChildCount ?? 0); i++) {
        const stmt = body.namedChild(i);
        const a = stmt?.type === 'expression_statement' ? stmt.namedChild(0) : null;
        if (a?.type !== 'assignment') continue;
        const left = a.childForFieldName?.('left');
        if (left?.type !== 'identifier') continue;
        pushField(d, left.text, pyTypeName(a.childForFieldName?.('type'), pyModules, pyRepoModules));
      }
    }

    // `@property def params(self) -> QueryParams` — `self.params` reads the
    // property, so the field's type is the getter's return type. httpx writes
    // `self.params.set(key, value)` in `URL.copy_set_param`, and this is what
    // tells `QueryParams.set` from `Cookies.set`. Only a decorated getter
    // counts: `self.<plain method>.x()` would be a call on a bound method,
    // which no real code writes, and requiring the decorator keeps the fact
    // read rather than assumed.
    for (const d of defs) {
      if (d.kind !== 'function' && d.kind !== 'method') continue;
      if (!d.node) continue;
      const dec = d.node.parent?.type === 'decorated_definition' ? d.node.parent.text : '';
      if (!/@(?:\w+\.)*(?:property|cached_property)\b/.test(dec)) continue;
      const type = pyTypeName(d.node.childForFieldName?.('return_type'), pyModules, pyRepoModules);
      pushField(enclosingClass(d.node), d.name, type);
    }
  }
  // The same idea as the Python and Go binding maps: one entry per name per scope,
  // so a call written on a name can be keyed and looked up later. The position is
  // part of the key because one function can bind one name in several scopes.
  // Every name this file's imports bind. `Test.createTestingModule(...)` is
  // @nestjs/testing's Test, not a repo symbol, and nothing said so — the call
  // fell through to the bare-name fallback and was guessed at whatever single
  // repo symbol shared the method name. 264 such calls in nest.
  const tsImported = new Set();
  if (lang === 'ts' || lang === 'js') {
    for (const c of caps) {
      if (c.name !== 'import.binding') continue;
      for (let i = 0; i < (c.node.namedChildCount ?? 0); i++) {
        const part = c.node.namedChild(i);
        if (!part) continue;
        if (part.type === 'identifier') tsImported.add(part.text); // `import x from …`
        else if (part.type === 'namespace_import') {              // `import * as ns from …`
          const id = part.namedChild(0);
          if (id?.type === 'identifier') tsImported.add(id.text);
        } else if (part.type === 'named_imports') {
          for (let j = 0; j < (part.namedChildCount ?? 0); j++) {
            const spec = part.namedChild(j);
            if (spec?.type !== 'import_specifier') continue;
            // `{ Thing as Test }` binds Test, not Thing.
            const bound = spec.childForFieldName?.('alias') ?? spec.childForFieldName?.('name');
            if (bound?.text) tsImported.add(bound.text);
          }
        }
      }
    }
  }

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
        const cls = defs.filter((d) => d.kind === 'class' && d.node
          && b.node.startIndex >= d.node.startIndex && b.node.endIndex <= d.node.endIndex)
          .sort((x, y) => y.node.startIndex - x.node.startIndex)[0];
        const type = tsStatedTypeName(decl, cls?.name ?? null);
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
    // Class FIELD types. Keyed by the class, not by a position: the field is
    // declared once at the top of the class and used in methods far below it, and
    // often in a SUBCLASS in another file. Two keys per field, exactly as C++ does
    // and for the same measured reason — nest ships three sample apps that each
    // declare a `RecipesService`, so the class-wide key alone would collect three
    // types under one name and answer none of them. The call site prefers the
    // file-scoped key; the resolver falls back to the class-wide one, which is what
    // reaches a field declared in another file.
    for (const c of caps) {
      if (c.name !== 'ts.field') continue;
      // A parameter is a field only when it carries a modifier:
      // `constructor(private readonly svc: Svc)` declares one, `constructor(x: T)`
      // does not. `readonly` alone is an anonymous token with no node of its own,
      // so the node's own text is what says it is there.
      if (c.node.type !== 'public_field_definition') {
        // The modifier is not always first. nest writes
        // `@InjectModel(Cat.name) private readonly catModel: Model<Cat>`, and a
        // decorator takes that position — which is why 157 nest fields, all of
        // them dependency injection, were skipped and their type went in under
        // the parameter's own key where no call site ever looks.
        //
        // So: any child may be the accessibility modifier, and `readonly` — an
        // anonymous token with no node — is looked for in the text BEFORE the
        // parameter's name rather than at the very start.
        const kids = c.node.namedChildren ?? [];
        const nameNode = kids.find((n) => n.type === 'identifier');
        const head = nameNode
          ? c.node.text.slice(0, nameNode.startIndex - c.node.startIndex) : c.node.text;
        const modifier = kids.some((n) => n.type === 'accessibility_modifier') ||
          /\breadonly\b/.test(head);
        if (!modifier) continue;
      }
      const name = c.node.type === 'public_field_definition'
        ? c.node.childForFieldName?.('name')?.text
        : c.node.namedChildren.find((n) => n.type === 'identifier')?.text;
      const type = tsStatedTypeName(c.node);
      if (!name || !type) continue;
      const cls = defs.filter((d) => d.kind === 'class' && within(c, d)).sort(innermostFirst)[0];
      if (!cls) continue;
      fieldTypes.push({ key: `${cls.name}#field:${name}`, type, file });
      fieldTypes.push({ key: `${file}|${cls.name}#field:${name}`, type, file });
    }
    // `class Sub extends Base`, recorded so the resolver can look a field up in the
    // class that really declares it. Only a plain name counts: `extends mixin(Base)`
    // names no single base, and guessing one would invent a whole method set.
    // `build(): Svc` — the declared result, keyed "<qname>#ret", exactly as Go
    // and Python write it, so Pass R follows a "#ret:build" marker to it with
    // no new pass. All three TypeScript graphs in the study held zero of these.
    for (const d of defs) {
      if (d.kind !== 'function' && d.kind !== 'method') continue;
      const type = tsReturnTypeName(d.node);
      if (type) fieldTypes.push({ key: `${d.qname}#ret`, type, file });
    }

    for (const c of caps) {
      if (c.name !== 'ts.extends') continue;
      const cls = defs.filter((d) => d.kind === 'class' && within(c, d)).sort(innermostFirst)[0];
      if (!cls) continue;
      const value = c.node.namedChild(0);
      // A dotted path and nothing else. `new Foo().Bar` is a `member_expression`
      // too, and its `property` is `Bar` — a name the source never wrote as a base
      // class. Recording it would send the reader below to whatever class in the
      // repo happens to be called `Bar` and let that class's clause refuse rows.
      const dotted = value?.type === 'member_expression' &&
        /^[\w$]+(\.[\w$]+)*$/.test(value.text);
      const base = value?.type === 'identifier' ? value.text
        : dotted ? value.childForFieldName?.('property')?.text : null;
      if (base && base !== cls.name) {
        fieldTypes.push({ key: `${cls.name}#extends`, type: base, file });
        continue;
      }
      // There IS a base class and the extractor could not name it. That is a
      // DIFFERENT fact from "this class has no extends clause", and the two must
      // not look alike in the graph: local-sqlite.mjs walks the base chain to
      // collect what a class declares it implements, and reading this as "extends
      // nothing" ends the walk and lets it refuse a row the base really carries.
      // Measured through the real indexer: `class C extends Mix() implements
      // Other`, where the mixin's class implements `Serializer`, answered
      // `["C.serialize"]` before this branch and `[]` while the marker was missing.
      //
      // `class C extends C` — or `extends ns.C` — counts as unnameable as well: the
      // only name available is the class's own, which says nothing about which
      // class the base really is.
      fieldTypes.push({ key: `${cls.name}#extendsUnknown`, type: '1', file });
      fieldTypes.push({ key: `${file}|${cls.name}#extendsUnknown`, type: '1', file });
    }
    // Every interface the clause names, one row per pair. `implements A, B` is
    // ordinary code, and a single `<Class>#implements` key holding a name would
    // cancel itself out — every field_types reader folds a key to one value and
    // poisons it when two rows disagree. So the fact lives in the KEY and the value
    // is a marker.
    //
    // Three node shapes, all measured against the grammar: `type_identifier` for a
    // plain name, `generic_type` whose first named child is the name for
    // `Serializer<X, Y>`, and `nested_type_identifier` for `ns.Outer.Iface`, where
    // only the last segment can match a stored qname.
    for (const c of caps) {
      if (c.name !== 'ts.implements') continue;
      const cls = defs.filter((d) => d.kind === 'class' && within(c, d)).sort(innermostFirst)[0];
      if (!cls) continue;
      for (let i = 0; i < c.node.namedChildCount; i++) {
        const n = c.node.namedChild(i);
        const raw = n.type === 'generic_type' ? n.namedChild(0)?.text : n.text;
        const name = raw ? raw.split('.').pop() : null;
        if (!name || name === cls.name) continue;
        fieldTypes.push({ key: `${cls.name}#implements:${name}`, type: '1', file });
        fieldTypes.push({ key: `${file}|${cls.name}#implements:${name}`, type: '1', file });
      }
    }
    // A value declared at the TOP of a module, keyed by its name alone so another
    // file can look it up. `export const NestFactory = new NestFactoryStatic();` is
    // declared once and called from everywhere, and the call site has no local of
    // that name to key on. Top-level only: a name bound inside a function is not
    // visible to another file, so offering it repo-wide would be an invention.
    // Two modules binding one name to different types cancel out, the same way
    // every other type row does.
    for (const [name, binds] of tsVarKeys) {
      for (const b of binds) {
        if (b.node.parent?.type !== 'variable_declarator') continue;
        if (defs.some((d) => within({ startLine: b.node.startPosition.row + 1,
          startCol: b.node.startPosition.column,
          endLine: b.node.startPosition.row + 1,
          endCol: b.node.startPosition.column + name.length }, d))) continue;
        const type = tsStatedTypeName(b.node.parent);
        if (type) fieldTypes.push({ key: `#value:${name}`, type, file });
      }
    }
    // Type aliases, keyed the same way C++ keys its typedefs, so the same resolver
    // hop follows them.
    for (const c of caps) {
      if (c.name !== 'ts.alias') continue;
      const name = c.node.childForFieldName?.('name')?.text;
      const target = tsAliasTargetName(c.node);
      if (name && target && name !== target) fieldTypes.push({ key: `#alias:${name}`, type: target, file });
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

  // C++ receiver types. One entry per name per scope, keyed and looked up exactly
  // as Go's, Python's and TypeScript's are, so the SAME field_types table and the
  // same resolver guards answer them.
  //
  // Two kinds of row go in:
  //   `<scope>#var:<name>@<pos>` -> the type written on a local or a parameter.
  //   `<Class>#field:<name>`     -> the type written on a class field. Keyed by the
  //      class rather than by position, because the everyday C++ layout puts the
  //      field in a header and the method that uses it in a .cc, so the two are
  //      never in one scope.
  const cppVarKeys = new Map(); // name -> [{ key, span }, ...]
  if (lang === 'cpp') {
    // Type aliases first, so a declaration that names one can be followed. Keyed by
    // the alias name alone: an alias is usually the only thing in a repo called
    // that, and when it is not, the resolver sees two types for one key and refuses
    // — the same rule it applies to every other type row.
    for (const c of caps) {
      if (c.name !== 'cpp.alias') continue;
      const name = c.node.type === 'type_definition'
        ? c.node.childForFieldName?.('declarator')?.text
        : c.node.childForFieldName?.('name')?.text;
      const target = cppWrittenType(c.node);
      if (!name || !target || name === target) continue;
      fieldTypes.push({ key: `#alias:${name}`, type: target, file });
      // An alias declared inside a class body means that class's alias inside it,
      // whatever else in the repo carries the name. leveldb has `class Table` in
      // table.h AND `typedef SkipList<…> Table;` inside MemTable, and inside MemTable
      // the name means the typedef — so the class-scoped key is tried first.
      let cls = c.node.parent;
      while (cls && cls.type !== 'class_specifier' && cls.type !== 'struct_specifier') cls = cls.parent;
      const clsName = cls?.childForFieldName?.('name')?.text;
      if (clsName) fieldTypes.push({ key: `${clsName}#alias:${name}`, type: target, file });
    }
    // `class Derived : public Base` -> "Derived#extends" = "Base", the same key
    // shape ts.extends writes, so the resolver's walk is one lookup either way.
    //
    // Exactly one base or nothing. `class Both : public Left, public Right` names
    // no single base and choosing one would hand Both a method set it may not
    // have — the same rule this file applies to an ambiguous alias and to a field
    // whose type was declared twice.
    for (const c of caps) {
      if (c.name !== 'cpp.extends') continue;
      const cls = c.node.parent;
      const name = cls?.childForFieldName?.('name')?.text;
      if (!name) continue;
      const bases = [];
      for (let i = 0; i < c.node.namedChildCount; i++) {
        const ch = c.node.namedChild(i);
        // The names a base can be written as. An access specifier and the virtual
        // keyword are unnamed or their own node types, so they never land here.
        if (!ch) continue;
        if (ch.type === 'type_identifier' || ch.type === 'qualified_identifier'
            || ch.type === 'template_type' || ch.type === 'sized_type_specifier') {
          bases.push(ch.text);
        }
      }
      if (bases.length !== 1) continue;
      // `ns::Base<T>` -> `ns.Base`, the spelling the graph stores qnames in.
      const base = bases[0].replaceAll('::', '.').replace(/<.*/, '').replace(/[*&\s]+$/, '');
      if (base && base !== name) fieldTypes.push({ key: `${name}#extends`, type: base, file });
    }
    for (const c of caps) {
      if (c.name !== 'cpp.decl') continue;
      const type = cppWrittenType(c.node);
      if (!type) continue;
      let scope = c.node.parent;
      while (scope && !CPP_SCOPE_NODES.has(scope.type)) scope = scope.parent;
      if (!scope) continue;
      const names = cppDeclaredNames(c.node, scope.type === 'compound_statement');
      if (!names.length) continue;
      // A field declaration belongs to the class that holds it, not to a block. Two
      // keys per field: one named after the class, which is what a method defined in
      // another file can look up, and one that also names this file. leveldb ships
      // three benchmark programs, each with its own `class Benchmark` and its own
      // `db_` field of a different type; on the class-wide key alone all three types
      // landed together, the type came out ambiguous, and every `db_->…` call in all
      // three files stayed unresolved. The call site prefers the file-scoped key when
      // the declaration is in its own file — see cppReceiverKey.
      if (c.node.type === 'field_declaration') {
        let cls = c.node.parent;
        while (cls && cls.type !== 'class_specifier' && cls.type !== 'struct_specifier') cls = cls.parent;
        const clsName = cls?.childForFieldName?.('name')?.text;
        if (!clsName) continue;
        for (const n of names) {
          fieldTypes.push({ key: `${clsName}#field:${n.text}`, type, file });
          fieldTypes.push({ key: `${file}|${clsName}#field:${n.text}`, type, file });
        }
        continue;
      }
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      for (const n of names) {
        const at = `@${n.startPosition.row + 1}:${n.startPosition.column}`;
        const key = owner ? `${owner.id}#var:${n.text}${at}` : `${file}#var:${n.text}${at}`;
        if (!cppVarKeys.has(n.text)) cppVarKeys.set(n.text, []);
        cppVarKeys.get(n.text).push({
          key,
          span: {
            startLine: scope.startPosition.row + 1, startCol: scope.startPosition.column,
            endLine: scope.endPosition.row + 1, endCol: scope.endPosition.column,
          },
        });
        fieldTypes.push({ key, type, file });
      }
    }
  }
  // The binding in scope at this point, innermost first — of two scopes that both
  // hold one position, the inner one starts later.
  const cppVarKeyAt = (name, node) => {
    const line = node.startPosition.row + 1, col = node.startPosition.column;
    const hits = (cppVarKeys.get(name) ?? []).filter((b) =>
      posLE(b.span.startLine, b.span.startCol, line, col) &&
      posLE(line, col, b.span.endLine, b.span.endCol));
    hits.sort((a, b) => b.span.startLine - a.span.startLine || b.span.startCol - a.span.startCol);
    return hits[0]?.key ?? null;
  };

  // The field_types key a C++ call written on `recv` belongs to, or null when the
  // source gives nothing to key on — and then the bare-name fallback stays, which
  // is the right answer for a receiver whose type we cannot read.
  //
  // Three shapes, in the order C++ makes them likely:
  //   `b.Put(k)`      -> the local or parameter `b`, keyed by scope and position.
  //   `rep_.Put(k)`   -> a field of the class the call is written in. The field's
  //                      own declaration is usually in a header, so the key names
  //                      the class rather than a position.
  //   `h->rep.Put(k)` -> a field of a receiver this file typed. The type of `h` is
  //                      read here, from the rows just built, so the key is the
  //                      same `<Class>#field:<name>` shape as the case above.
  const cppOwningClass = (enclosing) => {
    if (!enclosing) return null;
    // An out-of-class definition writes the class in its own declarator:
    // `void Writer::Run()` gives the localPath `Writer.Run`.
    if (enclosing.localPath?.includes('.')) {
      return enclosing.localPath.split('.').slice(0, -1).pop();
    }
    // Written inside the class body, so the container IS the class.
    const owner = defs.find((d) => d.id === enclosing.container_id);
    return owner && (owner.kind === 'class' || owner.kind === 'struct') ? owner.name : null;
  };
  const cppTypeOfKey = new Map();
  if (lang === 'cpp') for (const f of fieldTypes) cppTypeOfKey.set(f.key, f.type);
  const cppReceiverKey = (recv, enclosing) => {
    if (!recv) return null;
    if (recv.type === 'identifier') {
      const local = cppVarKeyAt(recv.text, recv);
      if (local) return local;
      const cls = cppOwningClass(enclosing);
      if (!cls) return null;
      // This file's own declaration wins over the class-wide one — see the two-key
      // comment above. `cppTypeOfKey` holds only this file's rows, so a hit there is
      // exactly "the class is declared here too".
      const scoped = `${file}|${cls}#field:${recv.text}`;
      return cppTypeOfKey.has(scoped) ? scoped : `${cls}#field:${recv.text}`;
    }
    // `shard_[Pick(h)].Insert(k)`: an array of a known type is still that type,
    // whichever element the subscript picks. leveldb's sharded cache is written this
    // way, and without it the call was one more row in a gap banner.
    if (recv.type === 'subscript_expression') {
      return cppReceiverKey(recv.childForFieldName?.('argument'), enclosing);
    }
    // `h->rep.Put(k)`: name the type that owns the field, exactly as the branch
    // above would if the field had been written bare.
    if (recv.type === 'field_expression') {
      const inner = recv.childForFieldName?.('argument');
      const field = recv.childForFieldName?.('field')?.text;
      if (inner?.type !== 'identifier' || !field) return null;
      const innerKey = cppReceiverKey(inner, enclosing);
      const innerType = innerKey && cppTypeOfKey.get(innerKey);
      if (!innerType) return null;
      const cls = innerType.split('.').pop();
      const scoped = `${file}|${cls}#field:${field}`;
      return cppTypeOfKey.has(scoped) ? scoped : `${cls}#field:${field}`;
    }
    return null;
  };

  const refMap = { 'reference.call': 'call', 'reference.import': 'import', 'reference.include': 'include' };
  // A pure virtual recovered from a macro-broken class body reads as
  // `Insert(int k) = 0` — an assignment to a call — so the call rule captures it
  // and the graph gains an edge saying the interface method calls itself. Suppress
  // exactly those: same line, same name as a member we synthesised from that very
  // line. Nothing else can match, so a real `matrix(i, j) = 0;` keeps its edge.
  const macroDeclSites = new Set(macroMembers.map((m) => `${m.startLine}:${m.name}`));
  const edges = [];
  for (const c of caps) {
    const kind = refMap[c.name];
    if (!kind) continue;
    if (kind === 'call' && macroDeclSites.has(`${c.startLine}:${c.text}`)) continue;
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
      // `x.m()` / `x->m()`. cppCallTarget kept the bare method name because the
      // receiver's type is not in the source at the call. It usually IS in the
      // source somewhere else, though — on the declaration — so key the call on
      // the receiver and let the resolver read the type. Keyed exactly like Go's
      // and TypeScript's, so the same passes and the same guards answer it.
      if (c.node?.type === 'field_identifier' && c.node.parent?.type === 'field_expression') {
        const recv = c.node.parent.childForFieldName?.('argument');
        const key = cppReceiverKey(recv, enclosing);
        if (key) { field_key = key; method = c.text; }
      }
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
          } else if (obj?.type === 'attribute' &&
                     ['self', 'cls'].includes(obj.childForFieldName?.('object')?.text ?? '')) {
            // `self.jar.set(…)` — a call on a class FIELD, and the shape Python
            // writes most. It carried no key at all until now, so no type could
            // ever answer it: 115 such calls in httpx, 51 in flask, 36 in
            // requests. Keyed on the class, not on a position, because the
            // field is usually bound in `__init__` far from the call. The file
            // goes in front for the reason C++ and TypeScript need it — two
            // classes of one name in one repo would otherwise share the key.
            const fieldName = obj.childForFieldName?.('attribute')?.text;
            const cls = defs.filter((d) => d.kind === 'class' && within(c, d)).sort(innermostFirst)[0];
            if (fieldName && cls) {
              field_key = `${file}|${cls.name}#field:${fieldName}`;
              method = c.text;
            }
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
            // `NestFactory.create(app)` — a call written on a CLASS, not on a
            // value. The source names the owner outright, so it is not a guess;
            // it was falling through to one only because the receiver is not a
            // variable and nothing keyed it. The name is recorded rather than
            // written into dst_name so that when no repo class carries it — an
            // imported library class — the old bare-name fallback is left exactly
            // as it was. This pass adds a fact, it never removes one.
            else { field_key = `#static:${obj.text}`; method = c.text; }
          } else if (obj?.type === 'member_expression' &&
                     obj.childForFieldName?.('object')?.type === 'this') {
            // `this.serializer.serialize(…)` — a call on a class FIELD, and the
            // shape TypeScript writes most. The field's own declaration is usually
            // far above, and often in a base class in another file, so the key names
            // the class rather than a position. This file's name goes in front for
            // the same reason C++ needs it: two classes of one name in one repo
            // would otherwise share the key. The resolver falls back to the
            // class-wide key and then walks the extends chain.
            const fieldName = obj.childForFieldName?.('property')?.text;
            const cls = defs.filter((d) => d.kind === 'class' && within(c, d)).sort(innermostFirst)[0];
            if (fieldName && cls) {
              field_key = `${file}|${cls.name}#field:${fieldName}`;
              method = c.text;
            }
          }
        }
      }
    }
    // A plain-identifier call to a builtin or a predeclared type names nothing in
    // the repo. Marked here, once, so neither the resolver nor the gap report has
    // to keep a Go word list in SQL.
    //
    // TypeScript's version of the same fact is a call written ON a global object,
    // `JSON.parse(s)`. The `#static:` key above is exactly the case where the
    // receiver is a plain name that no local binds, so it is the one place where
    // "this is the global" can be said. A repo that declares its own class of that
    // name overrides it later — see resolveTsStaticCalls.
    //
    // Python's version is a call written as a PLAIN NAME. `set(xs)` is the
    // builtin; `jar.set(x)` is a method on a value and must be left alone, so
    // the mark is refused whenever the name hangs off an attribute.
    const external = (lang === 'go' && c.node?.type !== 'field_identifier' &&
      (GO_BUILTINS.has(c.text) || GO_PREDECLARED_TYPES.has(c.text))) ||
      (lang === 'py' && kind === 'call' && c.node?.parent?.type !== 'attribute' &&
        PY_BUILTINS.has(c.text)) ||
      ((lang === 'ts' || lang === 'js') && field_key?.startsWith('#static:') &&
        (JS_GLOBALS.has(field_key.slice('#static:'.length)) ||
          tsImported.has(field_key.slice('#static:'.length)))) ? 1 : 0;
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
