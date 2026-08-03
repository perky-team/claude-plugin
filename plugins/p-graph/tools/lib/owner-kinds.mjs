// The kinds that OWN their members. A call the source wrote ON something
// (`x.m()`) can only reach a member of one of these. A function declared inside
// another function body is a local: the only call that can reach it is the plain
// name written next to it.
//
// `namespace` is here because a TypeScript `namespace X { export function f() }`
// really does own `f` — `X.f()` is the normal way to call it.
//
// One list, two readers: the parse driver uses the Set to bind a `this.m()` call
// to the enclosing type, and the SQLite store pastes the SQL literal into its
// resolver guards. Keeping two hand-written copies meant adding a kind to one of
// them would silently stop a `this.m()` call from resolving, with nothing failing
// to say so. The SQL literal is generated from the Set, so they cannot drift.
export const OWNER_KINDS = new Set(['class', 'struct', 'interface', 'namespace']);

// The same list as a SQL `IN (...)` literal: ('class','struct',...).
// Every value is a fixed identifier written above, so there is nothing to escape
// and no user input reaches this string.
export const OWNER_KINDS_SQL = `(${[...OWNER_KINDS].map((k) => `'${k}'`).join(',')})`;
