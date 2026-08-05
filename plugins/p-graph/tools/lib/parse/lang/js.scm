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

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.call)
(import_statement source: (string) @reference.import)
