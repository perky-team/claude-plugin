const USAGE = `Usage: pobserve <command> [options]

Commands:
  pobserve watch     Live merged event stream across observed plugins
  pobserve status    One-shot snapshot (counters + running/failed)
  pobserve capture   Headless: run the bus + on-disk journal, no UI
  help               Show this help

Options:
  --plugin=<name>    filter to one plugin (watch)
  --severity=<lvl>   filter by min severity (watch)
  --journal          also append events to .pobserve/events.jsonl (watch)
`;

const KNOWN = new Set(['watch', 'status', 'capture', 'help']);

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help') { process.stdout.write(USAGE); return 0; }
  if (!KNOWN.has(command)) { process.stderr.write(`unknown command: ${command}\n`); return 2; }
  // command implementations wired in Task 12.
  process.stdout.write(USAGE);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
