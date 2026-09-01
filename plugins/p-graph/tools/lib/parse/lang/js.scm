;; definitions (JavaScript grammar — no TypeScript-only node types)
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(field_definition (property_identifier) @name (arrow_function)) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name (arrow_function))) @definition.function

;; `const Widget = class { render() {} }`. The class has no declaration of its
;; own, so without this its methods have no owner and no member call reaches
;; them. Anchored on the declarator, not on the declaration, so
;; `const A = class{}, B = class{}` gives two definitions instead of one.
(variable_declarator name: (identifier) @name (class)) @definition.class

;; A function passed as a call ARGUMENT — the same rule ts.scm carries, kept in
;; step so a `.mjs` file and a `.ts` file do not answer differently for identical
;; code. It is not a declaration, so nothing used to name it and every call inside
;; it had no caller. The capture sits on the FUNCTION, not on the enclosing call,
;; and the driver drops any of these that a NAMED definition encloses — see
;; CALLBACK_DEF_TYPES there for why.
(call_expression arguments: (arguments [(arrow_function) (function_expression) (generator_function)] @definition.function))

;; Names a JavaScript scope binds to a value — the same rules ts.scm has carried
;; since the TypeScript round, which this file never got. Without them a .js file
;; recorded no binding and no type at all: every identifier receiver fell through
;; to the "#static:" key, matched no class of that name, and became a bare-name
;; guess. Measured on axios, which is 191 .js files against 23 .ts, that left
;; 9 of 7,940 member calls resolved with certainty — 0.1%, the lowest in the study,
;; while `const headers = new AxiosHeaders()` sat one line above the call.
;;
;; The parameter rule is the OPPOSITE of ts.scm's, and it has to be. In the
;; TypeScript grammar a plain parameter always parses as a required_parameter
;; wrapping the identifier; in this grammar it is a bare identifier directly under
;; formal_parameters, and required_parameter does not exist at all. A pattern the
;; grammar can never produce does not match nothing — it fails to compile, and
;; takes every other capture in this file with it.
(formal_parameters (identifier) @var.decl)
(assignment_pattern left: (identifier) @var.decl)
(rest_pattern (identifier) @var.decl)
(variable_declarator name: (identifier) @var.decl)
;; `x => x.foo()` writes its one parameter without brackets, so it is a direct
;; child of the arrow function rather than a formal_parameters list.
(arrow_function parameter: (identifier) @var.decl)

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.call)
(import_statement source: (string) @reference.import)
;; The NAMES an import binds — see the same rule in ts.scm.
(import_statement (import_clause) @import.binding)

;; `export { RealBase as Base }` — see the same rule in ts.scm. A `.js` barrel can
;; rename a class a `.ts` file declares, and the name it hands out is then written
;; in files that rename nothing. Only this half of the rule exists here: the
;; JavaScript grammar has no `import_alias` and no `import_require_clause` node, and
;; both were tried against the real grammar and fail to compile.
(export_specifier alias: (identifier) @export.renamed)
