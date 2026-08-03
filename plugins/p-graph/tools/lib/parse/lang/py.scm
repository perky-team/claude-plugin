(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class

(call function: (identifier) @reference.call)
(call function: (attribute attribute: (identifier) @reference.call))
(import_statement name: (dotted_name) @reference.import)
(import_from_statement module_name: (dotted_name) @reference.import)
;; `import numpy as np`. The alias is the name this file binds to the module, so
;; the driver can tell `np.array(...)` (module-qualified) from `s.get(...)` (a
;; call on a value). The module path is captured too, which also gives an
;; aliased import the import edge the plain rule above never recorded for it.
(import_statement name: (aliased_import
  name: (dotted_name) @reference.import
  alias: (identifier) @import.alias))
