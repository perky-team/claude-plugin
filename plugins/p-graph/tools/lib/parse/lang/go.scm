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

; Declared types of the things a call can be made on. A call like `db.Get(...)`
; only resolves if we know what `db` is, and for a parameter or a var the source
; says so outright. Without this the resolver falls back to matching the bare
; method name, which is how a sync.Pool.Put became a caller of a repo method.
; Capture the whole declaration, not its names: this grammar gives the comma
; tokens of `var a, b T` the `name` field too, so a `name: (identifier) @x`
; pattern matches only the first name and silently drops the rest. The driver
; reads the names and the shared type off the node instead.
(parameter_declaration) @var.decl
(var_spec) @var.decl
(const_spec) @var.decl
(short_var_declaration) @var.decl
; `variadic_parameter_declaration` (`vals ...*T`) is left out on purpose. Its type
; field holds the ELEMENT type, and the parameter itself is a slice — recording the
; element type would state a type the name never has. A slice has no methods, so no
; valid call is made on such a name, and nothing is lost by leaving it out.
; Names bound by shapes whose type we cannot read: a range variable, a type-switch
; alias, a channel receive. We record only that the name is taken. Without that, a
; call on one of them would be answered with the type of a package-level variable
; that happens to share the name — a wrong answer instead of a missing one.
(range_clause left: (expression_list (identifier) @var.local))
(type_switch_statement alias: (expression_list (identifier) @var.local))
(receive_statement left: (expression_list (identifier) @var.local))

(call_expression function: (identifier) @reference.call)
(call_expression function: (selector_expression field: (field_identifier) @reference.call))
(import_spec path: (interpreted_string_literal) @reference.import)
