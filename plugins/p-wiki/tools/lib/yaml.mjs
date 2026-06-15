// Minimal YAML for our schema: flat key-value mapping, scalar values, flat string arrays.

export function parseYaml(text) {
  const out = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) { i++; continue; }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2];
    if (rest === '') {
      // block array follows
      const arr = [];
      i++;
      while (i < lines.length && /^\s+- /.test(lines[i])) {
        arr.push(parseScalar(lines[i].replace(/^\s+- /, '').trim()));
        i++;
      }
      out[key] = arr;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner === '' ? [] : inner.split(',').map(s => parseScalar(s.trim()));
      i++;
      continue;
    }
    out[key] = parseScalar(rest);
    i++;
  }
  return out;
}

function parseScalar(raw) {
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  // Double-quoted: unescape \" and \\ so the value round-trips with serializeScalar.
  if (/^"(.*)"$/.test(raw)) return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (/^'(.*)'$/.test(raw)) return raw.slice(1, -1);
  return raw;
}

export function stringifyYaml(obj) {
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - ${serializeScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${serializeScalar(val)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// A bare (unquoted) string must not be re-read by parseScalar/parseYaml as a
// different type. Quote it when it would otherwise parse as a number, a keyword
// (null/true/false/~), an inline array ([...]), or carries YAML-significant
// characters / surrounding whitespace.
function needsQuoting(s) {
  if (s === '') return true;
  if (/[:#"']/.test(s) || /^\s|\s$/.test(s)) return true;
  if (/^-?\d+$/.test(s)) return true;                       // would parse as a number
  if (s === 'null' || s === '~' || s === 'true' || s === 'false') return true;
  if (s.startsWith('[') && s.endsWith(']')) return true;    // would parse as an inline array
  if (s.startsWith('- ')) return true;                      // looks like a block-array item
  return false;
}

function serializeScalar(val) {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (needsQuoting(val)) return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return val;
  }
  throw new Error(`unsupported value for YAML: ${val}`);
}
