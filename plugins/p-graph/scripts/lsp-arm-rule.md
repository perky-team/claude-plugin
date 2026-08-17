## Language servers — answer structural questions with the LSP tool, checked with grep

This repo has a language server running. Use the `LSP` tool for structural
questions ("who calls X", "what breaks if I change Y", "how does X reach Y",
"where is X defined"). Use grep/Read for literal text — string contents,
comments, log messages. A language server reads the code the way the compiler
does, so its answer about a symbol is worth more than a text match on a name.

**Every LSP call needs a position: `filePath`, `line`, `character`.** So the
first step of any question is turning a name into a position, and there is a
cheap way and a dear way.

| To go from a name to a position | Do this |
|---|---|
| you know the name only | `workspaceSymbol` with `query` set to the name. Pass any file in the repo as `filePath` with `line: 1, character: 1` — those are ignored for this operation |
| the name is a method and several types own one | `workspaceSymbol` returns each one with its file. Pick by the file, then confirm with `hover` |
| you have a `file:line` already | read the line, count to the first character of the name, and use that |

**Do not grep to find the position.** `workspaceSymbol` is one call and it
already knows where every symbol is declared.

| Question | Operation |
|---|---|
| Where is X defined? | `workspaceSymbol`, then `goToDefinition` |
| What calls X? | `findReferences`, or `incomingCalls` for callers only |
| What does X call? | `outgoingCalls` |
| What breaks if I change X? | `incomingCalls`, then `incomingCalls` again on each result |
| How does X reach Y? | `outgoingCalls` from X, one level at a time, looking for Y |
| Which types implement this interface method? | `goToImplementation` |
| What type is this? | `hover` |
| What is in this file? | `documentSymbol` |

**`findReferences` and `incomingCalls` are not the same list.** `findReferences`
gives every mention of the symbol: the declaration itself, calls, a method used
as a value, a name in an import. `incomingCalls` gives only the functions that
call it, each with the call ranges inside them. For "list every call site" ask
`findReferences` and then drop the declaration and any mention that is not a
call — open the line if you cannot tell. For "who calls X" as a list of
functions, `incomingCalls` is the shorter road.

**Do not double-check a reference list by grepping for the name.** The server
type-checked the code. It already told the two things a text search cannot: which
`Put` this is, and which of the 107 lines that write `.ServeHTTP(` really reach
this method. Re-running a text search over an LSP answer adds cost and finds no
extra call site. Grep only when the LSP tool returned an error, or when you need
text that is not a symbol.

**What a language server cannot see, and you should say so.** A reference list is
complete for calls written in the code and resolved by the compiler. These are
outside it:

- a call made by reflection, or through a name held in a string
  (`getattr(obj, "update")()`, a registry keyed on a string)
- a call from a file the build excludes — another platform, another build tag
- generated code that is not in the tree
- for C++, a file that is not in `compile_commands.json`

None of these is a defect in the answer. But an answer that lists 24 call sites
and does not mention that a registry may add more is read as final when it is
not. Name the limit in one line when the symbol is the kind of thing a framework
dispatches to.

**When the server cannot answer, try once more before giving up.** A language
server loads the whole project before it can answer anything, and on a big repo
that takes a while. Until it finishes, every question gets the same kind of
refusal — `no active builds`, `no package for file`, an empty symbol list for a
name you can plainly see in the source. **That is "not yet", not "never".**

So on the first such answer: do something else useful for a moment — read the
file you are asking about — then ask the server the same question a second time.
Most of the time the second call answers.

Fall back to grep only after that second call also fails. When you do fall back,
say so in one line: which LSP call failed, what it said, and that the list below
came from a text search. That line matters more than it looks — it is the only
way a reader can tell an answer the server gave from an answer it did not.

**Give `file:line` for everything.** Every LSP result carries a URI and a range.
Convert it to a repo-relative path and a 1-based line number. A caller that calls
twice has two ranges — report both lines.
