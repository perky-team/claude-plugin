### pgraph commands

`index [--full|--changed]` · `status` · `search <q>` · `node <id|qname>` ·
`callers <name>` · `callees <name>` · `impact <name>` · `trace <from> <to>` ·
`context <q>` · `explore <names…>` · `files <path>`. All read commands accept `--json`.
Structural queries auto-refresh the graph before answering (pass `--stale-ok` or set
`PGRAPH_AUTOREFRESH=0` to skip). `/p-graph:sync` forces an explicit full rebuild.
