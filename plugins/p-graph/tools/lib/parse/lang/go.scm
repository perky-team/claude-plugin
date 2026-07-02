(package_clause (package_identifier) @package)

(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(method_declaration receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @receiver))))
(method_declaration receiver: (parameter_list (parameter_declaration type: (type_identifier) @receiver)))
(method_declaration receiver: (parameter_list (parameter_declaration name: (identifier) @receiver.name)))
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(struct_type (field_declaration_list (field_declaration) @field.decl))
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface

(call_expression function: (identifier) @reference.call)
(call_expression function: (selector_expression field: (field_identifier) @reference.call))
(import_spec path: (interpreted_string_literal) @reference.import)
