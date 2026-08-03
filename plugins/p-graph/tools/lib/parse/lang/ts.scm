;; definitions
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(method_definition name: (property_identifier) @name) @definition.method
(public_field_definition (property_identifier) @name (arrow_function)) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name (arrow_function))) @definition.function

;; A namespace owns its members, so index it as a definition — otherwise every
;; `export function` inside it gets no owner and `Util.slug(...)` cannot resolve.
;; `namespace X {}` and `module X {}` are the same node. `declare module "x" {}`
;; is deliberately left out: its name is a string (an external module), so it
;; declares nothing this repo defines.
(internal_module name: (identifier) @name) @definition.namespace
(internal_module name: (nested_identifier) @name) @definition.namespace
(module name: (identifier) @name) @definition.namespace

;; `const Widget = class { render() {} }`. The class has no declaration of its
;; own, so without this its methods have no owner and no member call reaches
;; them. Anchored on the declarator, not on the declaration, so
;; `const A = class{}, B = class{}` gives two definitions instead of one.
(variable_declarator name: (identifier) @name (class)) @definition.class

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.call)
(import_statement source: (string) @reference.import)
