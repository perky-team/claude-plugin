// R5 — parse command-line flags.
export function parseFlags(argv) {
  const set = {};
  const rest = [];

  const put = (name, value) => {
    const dot = name.indexOf('.');
    const section = dot === -1 ? '' : name.slice(0, dot);
    const key = dot === -1 ? name : name.slice(dot + 1);
    set[section] ??= {};
    set[section][key] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { rest.push(arg); continue; }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) { put(body.slice(0, eq), body.slice(eq + 1)); continue; }

    // Only the `--section.key value` form takes the next argument as its value.
    // A name with no dot is a plain flag and means `true`.
    const next = argv[i + 1];
    if (body.includes('.') && next !== undefined && !next.startsWith('--')) {
      put(body, next);
      i++;
      continue;
    }
    put(body, 'true');
  }

  return { set, rest };
}
