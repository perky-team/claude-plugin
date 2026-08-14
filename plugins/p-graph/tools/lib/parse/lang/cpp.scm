;; definitions
;; The body is required. `class Foo;` is a forward declaration, not a second copy
;; of the class — indexing it gives two nodes the same qname, and `node`/`impact`
;; then pick one of them at random. It also keeps the `class LEVELDB_EXPORT` half
;; of the misparse below out of the graph.
(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.class
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.struct

;; `class LEVELDB_EXPORT DB { … };`. A macro between `class` and the name makes
;; tree-sitter read the whole class as a function definition — or, when the class
;; lists two base classes, as a declaration. Either way the class_specifier keeps
;; only `class LEVELDB_EXPORT`. Export macros like this are normal in a public C++
;; header, and without these rules the class is missing from the graph and every
;; method written inside it looks like a free function of the surrounding
;; namespace.
;;
;; There is no @name capture: which field holds the real name changes with the
;; shape (`class M X final` puts `final` in the declarator, `class M1 M2 X` puts
;; M2 there), so the driver reads the name from the source instead and skips the
;; definition when it cannot — see cppMacroClassName. A real function definition
;; always has a function_declarator, never a plain identifier, so these rules
;; cannot match legitimate code; an ordinary `class Foo x;` can match the
;; declaration rules, and the driver refuses it.
(function_definition type: (class_specifier) declarator: (identifier)) @definition.class
(function_definition type: (struct_specifier) declarator: (identifier)) @definition.struct
(declaration type: (class_specifier) declarator: (identifier)) @definition.class
(declaration type: (struct_specifier) declarator: (identifier)) @definition.struct

;; A namespace owns its members, so index it as a definition — the same way a
;; TypeScript namespace is indexed. Without it every free function in a repo that
;; wraps its code in one namespace has no owner, and `geo::TotalArea(...)` cannot
;; resolve. The `name:` field is required on purpose: `namespace { ... }` names
;; nothing, and matching it would make the first symbol inside the block look
;; like the namespace's own name.
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(namespace_definition name: (nested_namespace_specifier) @name) @definition.namespace

;; One rule for every function and method definition, with no name capture. C++
;; wraps the declarator: `char*& Buf::Ref()` puts the function_declarator under a
;; pointer_declarator under a reference_declarator, so a query would need one
;; pattern per wrapper combination. The driver walks down to the
;; function_declarator instead and reads the name from there — which is also
;; where an out-of-class name (`PgStore::Get`), a destructor (`~Buf`) and an
;; operator (`operator==`) live.
(function_definition) @definition.function

;; ANY method declared in a class body, whether or not it has a body elsewhere.
;; It earns a node and then yields to its definition when the repo has one — see
;; SCHEMA_VERSION 9 and the drop at the head of resolve. One rule instead of a list
;; of special cases, and it covers three real shapes:
;;
;;   * a pure virtual (`virtual bool Valid() const = 0;`). A C++ interface is made
;;     of these and they can have no body in the class. Without them the interface
;;     method is missing while its implementations are present, so a question about
;;     the interface answers with an implementation — the wrong symbol, confidently.
;;     Measured on leveldb: `leveldb::Iterator::Valid` was absent while nine
;;     `Valid` implementations were there.
;;   * a method whose body the parse lost. `bool Insert(int f) LOCKS_EXCLUDED(mu_)
;;     { … }` splits in two: the real name stays here in the declaration and the
;;     body becomes a definition named after the annotation macro. 15 nodes in
;;     leveldb were called `LOCKS_EXCLUDED` or the like, and the methods they stood
;;     in for were in no answer at all.
;;   * a method this repo declares and never implements.
;;
;; A declaration that DOES have a definition is dropped, so no qname ends up with
;; two nodes — which would make the exact-qname pass refuse both.
(field_declaration
  declarator: (function_declarator declarator: (field_identifier) @name)) @definition.method

;; A pure virtual inside a class whose name a macro pushed out of the parse —
;; `class LEVELDB_EXPORT Cache { … };` — has NO rule here, because there is nothing
;; left to match: the broken body is a compound_statement and only the FIRST such
;; declaration survives it as anything at all. The driver reads them out of the
;; source instead, the same way it reads the class's own name — see
;; cppMacroPureVirtuals. Recovering one of a class's seven interface methods and
;; not the other six would be worse than recovering none: a reader cannot tell
;; which case they are looking at.

;; Every place C++ writes a type next to a name: a local, a parameter, a class
;; field. This is what lets a call written on a value (`b.Put(k)`, `p->Put(k)`)
;; name the type it belongs to instead of falling back to a bare-name guess —
;; 40% of the call edges in leveldb, none of them certain before this.
;;
;; The whole declaration node is captured, not the name inside it, because C++
;; wraps a declarator in a pointer, a reference, an array and an initialiser in
;; any combination: `Batch* b`, `Batch& b`, `Batch* b = Make()`, `Batch b[4]`.
;; One query pattern per combination is not maintainable, so the driver walks the
;; declarator down to the name — the same trade the function rule below makes.
;; A type alias. `typedef SkipList<const char*, KeyComparator> Table;` then
;; `Table table_;` — the declaration names `Table`, no class is called that, and the
;; receiver stayed untyped. leveldb's MemTable is written exactly this way.
(type_definition) @cpp.alias
(alias_declaration) @cpp.alias

;; `class Derived : public Base`. A call written on a receiver the source types as
;; Derived is a real call site of a method Base declares, and C++ was the only
;; supported language with no way to cross that line — TypeScript walks `extends`,
;; Go walks embedding. Measured on rocksdb: 1,623 of 3,521 class declarations
;; write a base and the graph held none of them, which lost two of the twelve call
;; sites of `CompactionPicker::ExpandInputsToCleanCut` and still said `complete`.
;;
;; The whole clause is captured and the driver reads the bases out of it, because a
;; base can be written four ways — `Base`, `ns::Base`, `Tmpl<T>`, with or without
;; an access specifier — and one query pattern per shape is not maintainable. The
;; driver records a base only when the clause names exactly ONE: multiple
;; inheritance names no single base, and picking one would invent a method set.
;;
;; A class whose name a macro pushed out of the parse (`class LEVELDB_EXPORT DB`)
;; has no usable name field here, so its base is not read. That is the same limit
;; the alias and field rules above already carry.
(class_specifier (base_class_clause) @cpp.extends)
(struct_specifier (base_class_clause) @cpp.extends)

(declaration) @cpp.decl
(parameter_declaration) @cpp.decl
(field_declaration) @cpp.decl

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (field_expression field: (field_identifier) @reference.call))
;; `geo::TotalArea(...)` and `Status::OK()`. Without this rule a qualified call
;; produced no edge at all, so the answer was silent and the gap report had
;; nothing to show either.
(call_expression function: (qualified_identifier) @reference.call)
(preproc_include path: (system_lib_string) @reference.include)
(preproc_include path: (string_literal) @reference.include)
