#!/usr/bin/env node

const VERSION = '1.0.0';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const command = args[0];
const KNOWN_COMMANDS = new Set(['new', 'set', 'promote', 'search', 'lint']);
if (!command || !KNOWN_COMMANDS.has(command)) {
  process.stderr.write(`pwiki: unknown command: ${command ?? '(none)'}\n`);
  process.exit(1);
}

process.stderr.write(`pwiki: command '${command}' not yet implemented\n`);
process.exit(3);
