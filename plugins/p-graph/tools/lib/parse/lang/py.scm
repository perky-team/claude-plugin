(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class

(call function: (identifier) @reference.call)
(call function: (attribute attribute: (identifier) @reference.call))
(import_statement name: (dotted_name) @reference.import)
(import_from_statement module_name: (dotted_name) @reference.import)
