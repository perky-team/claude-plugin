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

;; The names a `from ... import` statement binds: `from . import cli` makes `cli`
;; a module, and `cli.AppGroup()` is then module-qualified. The statement itself
;; does not say whether the name is a module or an ordinary value, so the driver
;; checks the resolved path against the repo's own modules before believing it.
(import_from_statement name: (dotted_name) @import.from)
(import_from_statement name: (aliased_import name: (dotted_name) @import.from))

;; Names a Python scope binds to a VALUE. A local or a parameter shadows an
;; imported module of the same name, and a call on it is then a call on a value.
;; Only real binding positions are captured: `self.cli = cli.AppGroup()` assigns
;; an attribute, not the name `cli`, and must not count.
;; Written as alternations inside one pattern per statement shape, not as one
;; pattern per shape: every extra pattern is matched against every node of every
;; Python file, and the flat form made indexing flask twice as slow.
(assignment left: [
  (identifier) @var.local
  (pattern_list (identifier) @var.local)
  (tuple_pattern (identifier) @var.local)
  (list_pattern (identifier) @var.local)])
(augmented_assignment left: (identifier) @var.local)
(for_statement left: [
  (identifier) @var.local
  (pattern_list (identifier) @var.local)
  (tuple_pattern (identifier) @var.local)])
(for_in_clause left: [
  (identifier) @var.local
  (pattern_list (identifier) @var.local)
  (tuple_pattern (identifier) @var.local)])
;; `with open(p) as f` and `except E as err` share the as_pattern shape.
(as_pattern alias: (as_pattern_target (identifier) @var.local))
(named_expression name: (identifier) @var.local)
(parameters [
  (identifier) @var.local
  (default_parameter name: (identifier) @var.local)
  (typed_parameter (identifier) @var.local)
  (typed_default_parameter name: (identifier) @var.local)
  (list_splat_pattern (identifier) @var.local)
  (dictionary_splat_pattern (identifier) @var.local)])
(lambda_parameters (identifier) @var.local)
