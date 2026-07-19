// plugins/p-observe/tools/lib/adapters/scalars.mjs
// Tolerant scalar reader for js-yaml.dump output. Zero-dep; never throws.

// Block/folded scalar header: |, >, with optional indent digit and chomp sign
// in either order (js-yaml.dump emits indent-then-chomp, e.g. |2-, >2+).
const BLOCK_INDICATOR = /^[|>](\d[+-]?|[+-]\d?|[+-]?\d?)$/;

export function unquote(s) {
  const t = String(s);
  if (t.length >= 2 && ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// Value of the `key:` declared on lines[i]. Inline when present and not a block
// indicator; otherwise the first non-empty following line, trimmed.
export function scalarValue(lines, i) {
  const line = lines[i] ?? '';
  const m = /:\s*(.*)$/.exec(line);
  if (!m) return '';
  const inline = m[1].trim();
  if (inline && !BLOCK_INDICATOR.test(inline)) return unquote(inline);
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    return lines[j].trim();
  }
  return '';
}
