;; definitions (JavaScript grammar — no TypeScript-only node types)
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(field_definition (property_identifier) @name (arrow_function)) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name (arrow_function))) @definition.function

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.call)
(import_statement source: (string) @reference.import)
