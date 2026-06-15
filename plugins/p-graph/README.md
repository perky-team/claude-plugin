# p-graph

A local code knowledge graph for Claude Code. `pgraph` indexes your repository
(TypeScript/JavaScript, Go, C++, Python) into a SQLite graph of symbols and their
call/import/extend edges, and answers structural questions — where a symbol is
defined, what calls it, what breaks if it changes, how one symbol reaches another —
from the index instead of grepping.

Skills: `init` (set up + first index), `sync` (incremental reindex), `help` (command cheat-sheet).
Fully local, no MCP server. See `docs/superpowers/specs/` for the design.
