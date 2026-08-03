(package_clause (package_identifier) @package)

(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(method_declaration receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @receiver))))
(method_declaration receiver: (parameter_list (parameter_declaration type: (type_identifier) @receiver)))
; A receiver on a generic type: `func (p *Partition[K, V]) …`. The type name sits
; inside a generic_type, so the plain rules above miss it — and a method with no
; receiver capture loses BOTH its qname qualification and the recvType that every
; resolver guard is keyed on.
(method_declaration receiver: (parameter_list (parameter_declaration
  type: (pointer_type (generic_type (type_identifier) @receiver)))))
(method_declaration receiver: (parameter_list (parameter_declaration
  type: (generic_type (type_identifier) @receiver))))
(method_declaration receiver: (parameter_list (parameter_declaration name: (identifier) @receiver.name)))
; Capture at the type_spec / type_alias level, NOT the enclosing type_declaration:
; a grouped `type ( A struct{}; B int )` block is one type_declaration with many
; specs, so anchoring on the declaration collapses every spec onto one node (all
; but the first are lost, and their identical spans corrupt qname nesting). The
; generic `@definition.type` rule also matches struct/interface specs; the driver
; dedups an identical span, keeping the most specific kind.
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(struct_type (field_declaration_list (field_declaration) @field.decl))
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name) @definition.type
(type_alias name: (type_identifier) @name) @definition.type

(call_expression function: (identifier) @reference.call)
(call_expression function: (selector_expression field: (field_identifier) @reference.call))
(import_spec path: (interpreted_string_literal) @reference.import)
