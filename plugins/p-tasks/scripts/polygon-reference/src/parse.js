// R1 — parse an INI file.
export function parseIni(text) {
  const out = {};
  let section = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]; out[section] ??= {}; continue; }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!pair) throw new SyntaxError(`line ${i + 1}: ${lines[i].trim()}`);
    out[section] ??= {};
    out[section][pair[1].trim()] = pair[2].trim();
  }
  return out;
}
