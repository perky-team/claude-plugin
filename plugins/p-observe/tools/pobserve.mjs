import { loadConfig, detectPlugins, paths as resolvePaths } from './lib/config.mjs';
import { createBus } from './lib/bus.mjs';
import { buildAdapters, runBackfill, startAll, stopAll, collectStatus } from './lib/core.mjs';
import { formatLine } from './lib/render/stream.mjs';
import { formatStatus } from './lib/render/status.mjs';
import { appendJournal, rotateJournal } from './lib/journal.mjs';

const USAGE = `Usage: pobserve <command> [options]

Commands:
  pobserve watch     Live merged event stream across observed plugins
  pobserve status    One-shot snapshot (counters + running/failed)
  pobserve capture   Headless: run the bus + on-disk journal, no UI
  help               Show this help

Options:
  --plugin=<name>    filter to one plugin (watch)
  --severity=<lvl>   filter by min severity: ok|info|warn|error (watch)
  --journal          also append events to .pobserve/<YYYY-MM-DD>.jsonl (watch)
`;

const SEV_ORDER = { ok: 0, info: 1, warn: 2, error: 3 };
const KNOWN = new Set(['watch', 'status', 'capture', 'help']);

function parseOpts(argv) {
  const o = { color: process.stdout.isTTY };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] ?? true;
  }
  return o;
}

function assemble(root, cfg, emit) {
  const paths = resolvePaths(root, cfg);
  const detected = detectPlugins(root, cfg);
  const adapters = buildAdapters({ root, cfg, paths, detected, emit });
  return { paths, adapters };
}

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help') { process.stdout.write(USAGE); return 0; }
  if (!KNOWN.has(command)) { process.stderr.write(`unknown command: ${command}\n`); return 2; }
  const root = process.cwd();
  const opts = parseOpts(argv.slice(1));

  const cfg = loadConfig(root);

  if (command === 'status') {
    const { adapters } = assemble(root, cfg, () => {});
    for (const ad of Object.values(adapters)) ad.backfill(); // seed snapshots
    process.stdout.write(formatStatus(collectStatus(adapters)) + '\n');
    return 0;
  }

  // watch / capture: build bus first, then adapters that emit into it.
  const bus = createBus({ size: cfg.bufferSize });
  const { paths, adapters } = assemble(root, cfg, bus.push);

  const journalOn = command === 'capture' || opts.journal === true || cfg.journal === true;

  if (journalOn) rotateJournal(paths.journalDir, Date.now(), cfg.journalRetentionDays);

  if (command === 'watch') {
    const minSev = typeof opts.severity === 'string' ? (SEV_ORDER[opts.severity] ?? 0) : 0;
    // Registered BEFORE runBackfill so backfilled/replayed history is displayed.
    bus.subscribe((e) => {
      if (typeof opts.plugin === 'string' && e.plugin !== opts.plugin && e.plugin !== `p-${opts.plugin}`) return;
      if (SEV_ORDER[e.severity] < minSev) return;
      process.stdout.write(formatLine(e, { color: opts.color }) + '\n');
    });
  } else {
    process.stderr.write('pobserve capture: journaling events (Ctrl-C to stop)\n');
  }

  runBackfill(adapters, { paths, cfg, emit: bus.push });

  // Registered AFTER runBackfill: only live events reach the journal, so
  // replayed/seeded history is never re-appended (no self-amplification on restart).
  if (journalOn) {
    bus.subscribe((e) => {
      try { appendJournal(paths.journalDir, e, Date.now()); }
      catch (err) { process.stderr.write('pobserve: journal write failed: ' + err.message + '\n'); }
    });
  }

  startAll(adapters);

  await new Promise((resolve) => {
    process.on('SIGINT', () => { stopAll(adapters); resolve(); });
    process.on('SIGTERM', () => { stopAll(adapters); resolve(); });
  });
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
