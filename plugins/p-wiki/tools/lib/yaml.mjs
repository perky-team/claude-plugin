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
  if (/^"(.*)"$/.test(raw)) return raw.slice(1, -1);
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

function serializeScalar(val) {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (/[:#"']/.test(val) || /^\s|\s$/.test(val)) return `"${val.replace(/"/g, '\\"')}"`;
    return val;
  }
  throw new Error(`unsupported value for YAML: ${val}`);
}
