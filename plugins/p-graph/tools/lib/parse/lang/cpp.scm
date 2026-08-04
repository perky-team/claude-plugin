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

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (field_expression field: (field_identifier) @reference.call))
;; `geo::TotalArea(...)` and `Status::OK()`. Without this rule a qualified call
;; produced no edge at all, so the answer was silent and the gap report had
;; nothing to show either.
(call_expression function: (qualified_identifier) @reference.call)
(preproc_include path: (system_lib_string) @reference.include)
(preproc_include path: (string_literal) @reference.include)
