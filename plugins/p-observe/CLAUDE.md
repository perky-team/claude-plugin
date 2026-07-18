# p-observe — contributor guide

Zero-touch observer. Key decisions:

- **Never modify observed plugins.** Adapters only read `.pshed/`, `docs/tasks/`, `.pgraph/`,
  `docs/wiki/`. All p-observe writes go under `.pobserve/`.
- **Never open `graph.db`.** That would force Node ≥ 22.5 and couple to p-graph's schema. The
  p-graph adapter only shells out to `pgraph status --json` and degrades to mtime-only when the
  CLI path is unset.
- **Torn-read rule.** Every parse-on-change adapter catches parse errors, keeps its prior snapshot
  as the baseline, and retries next tick — the observed plugins write non-atomically.
- **Zero runtime deps.** Nothing under `tools/` may `import` a bare package. Node built-ins + ANSI only.
- Adapter contract: `{ backfill(), start(), stop(), status() }`; the bus (`lib/bus.mjs`) is the only
  fan-out. Renderers and the journal sink are subscribers.
- Phase 2 (TUI) and the p-shed log enrichment are separate plans; see the design spec.
