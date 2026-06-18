(package_clause (package_identifier) @package)

(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(method_declaration receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @receiver))))
(method_declaration receiver: (parameter_list (parameter_declaration type: (type_identifier) @receiver)))
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface

(call_expression function: (identifier) @reference.call)
(call_expression function: (selector_expression field: (field_identifier) @reference.call))
(import_spec path: (interpreted_string_literal) @reference.import)
