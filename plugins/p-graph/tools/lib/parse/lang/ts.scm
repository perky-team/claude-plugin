;; definitions
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
;; `abstract class X` is a node type of its own in this grammar, so the rule above
;; never matched it — the class and every method in it were missing from the graph.
;; That is not a corner case: measured on nest, ClientProxy, Server and
;; ContextCreator, the base classes the framework hangs off, had zero nodes.
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(method_definition name: (property_identifier) @name) @definition.method
(public_field_definition (property_identifier) @name (arrow_function)) @definition.method
;; The methods an interface declares. TypeScript's main way of naming a set of
;; methods is an interface, and a call written through one is everyday code — but
;; the interface node had no members, so the call had nowhere to land. Measured on
;; nest: 312 interfaces, 0 members, and `callers "Serializer.serialize"` answered
;; "no symbol named Serializer.serialize".
;; Two shapes declare a method: `serialize(v: T): O;` and `handle: (x) => void`. A
;; property of any other type is data, not a method, so it stays out.
;; The definition is anchored on the METHOD_SIGNATURE / PROPERTY_SIGNATURE, not on
;; the interface_body around it — the same fix go.scm:37 needed, for the same
;; reason. Anchoring outside was measured wrong twice over: an interface declaring
;; `serialize`, `deserialize` and `reset` recorded ONE member, and the signature
;; handed to it was `export interface Serializer {`, the interface's own
;; declaration line, not the method's.
(interface_body (method_signature name: (property_identifier) @name) @definition.method)
(interface_body (property_signature
  name: (property_identifier) @name
  type: (type_annotation (function_type))) @definition.method)
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

;; A function passed as a call ARGUMENT. It is not a declaration, so nothing used
;; to name it and every call inside it had no caller — and in TypeScript that is
;; where nearly all test code lives (`describe('x', () => …)`, `it('y', async () =>
;; …)`). 94% of this repo's own TypeScript call sites had no caller before this.
;;
;; The capture sits on the FUNCTION, not on the enclosing call: the definition's
;; span has to be the callback's own body, or a call written elsewhere in the same
;; call would look like it belongs to the callback. The driver drops any of these
;; that a NAMED definition encloses — see CALLBACK_DEF_TYPES there for why — and
;; names the survivors after the call beside them.
(call_expression arguments: (arguments [(arrow_function) (function_expression) (generator_function)] @definition.function))

;; references
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.call)
(import_statement source: (string) @reference.import)
;; The NAMES an import binds, not the module it reads from. A call written on
;; one of them — `Test.createTestingModule(...)` is @nestjs/testing's Test — is a
;; call on someone else's value, and the import statement says so outright. The
;; whole clause is captured and the driver reads the three shapes out of it
;; (default, `* as ns`, and each specifier's alias or name), because a query
;; cannot express "the alias if there is one, otherwise the name".
(import_statement (import_clause) @import.binding)

;; Names a TypeScript/JavaScript scope binds to a value. A call written on one of
;; these can only be resolved once we know what the name holds, so the binding has
;; to be recorded even when its type is not — see the driver, which keys the call on
;; the binding and lets the resolver decide.
;; The whole declaration is captured, not just its name: a type annotation and an
;; initialiser both hang off it, and Task 2 reads them from the same node.
;; No `(formal_parameters (identifier) @var.decl)` line here: in this grammar a
;; plain parameter is never a bare identifier directly under formal_parameters —
;; even an untyped one parses as a required_parameter wrapping the identifier. A
;; pattern for a parent/child pair the grammar can never produce does not just
;; match nothing, it fails to compile at all, and the whole query file (every
;; other capture in it too) fails with it. `(required_parameter (identifier) ...)`
;; below already reaches every ordinary parameter, typed or not.
(required_parameter (identifier) @var.decl)
(optional_parameter (identifier) @var.decl)
(variable_declarator name: (identifier) @var.decl)
;; `x => x.foo()` writes its one parameter without brackets, so it is a direct child
;; of the arrow function rather than a formal_parameters list.
(arrow_function parameter: (identifier) @var.decl)

;; The type written on a class FIELD. `this.<field>.<method>()` is the shape
;; TypeScript writes most and the one p-graph could not read at all: the receiver is
;; a member expression, not a name, so there was nothing to key the call on.
;; Measured on nest, 1,019 such calls stayed unresolved, and all 20 false rows in
;; the gap banner of `callers "ClassSerializerInterceptor.serialize"` were these.
(class_body (public_field_definition) @ts.field)
;; `constructor(private readonly svc: Svc)` declares a field and a parameter in one
;; line. It is how every NestJS class takes its dependencies. Only a parameter with
;; a modifier is a field, and TypeScript allows a modifier on a parameter only in a
;; constructor — so the driver's modifier check is the whole guard needed here.
(class_body (method_definition parameters: (formal_parameters (required_parameter) @ts.field)))
(class_body (method_definition parameters: (formal_parameters (optional_parameter) @ts.field)))

;; `class Sub extends Base` — the field a call is written on is often declared on a
;; base class in another file, so the resolver walks this chain. nest declares
;; `serializer` on ClientProxy and calls `this.serializer.serialize(…)` in every
;; subclass.
(class_heritage (extends_clause) @ts.extends)

;; `type ProducerSerializer = Serializer<…>`. No class is called ProducerSerializer,
;; so without following the alias a field declared with it has no type at all.
(type_alias_declaration) @ts.alias
