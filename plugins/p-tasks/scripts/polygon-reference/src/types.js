// R12 — an `integer` type. R13 — a `list` type. R14 — a `list<integer>` type.
// R15 — a `list<boolean>` type.
import { splitPath } from './paths.js';

const INT_RE = /^-?\d+$/;

// R13's empty-string special case: '' splits to [], not [''].
function splitList(raw) {
  return raw === '' ? [] : raw.split(',').map((piece) => piece.trim());
}

function pathCompare(a, b) {
  return a.path === b.path ? 0 : a.path < b.path ? -1 : 1;
}

export function coerceExtraTypes(value, schema) {
  const out = {};
  for (const [section, keys] of Object.entries(value)) out[section] = { ...keys };

  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    const type = rule.type;
    if (type !== 'integer' && type !== 'list' && type !== 'list<integer>' && type !== 'list<boolean>') continue;

    const [section, key] = splitPath(path);
    const raw = value[section]?.[key];
    if (raw === undefined) continue;

    if (type === 'integer') {
      if (INT_RE.test(raw)) out[section][key] = Number(raw);
      else errors.push({ path, message: 'must be an integer' });
      continue;
    }

    if (type === 'list') {
      out[section][key] = splitList(raw);
      continue;
    }

    const pieces = splitList(raw);
    if (type === 'list<integer>') {
      if (pieces.every((piece) => INT_RE.test(piece))) out[section][key] = pieces.map(Number);
      else errors.push({ path, message: 'must be a list of integers' });
      continue;
    }

    // type === 'list<boolean>'
    if (pieces.every((piece) => piece === 'true' || piece === 'false')) {
      out[section][key] = pieces.map((piece) => piece === 'true');
    } else {
      errors.push({ path, message: 'must be a list of true/false values' });
    }
  }

  errors.sort(pathCompare);
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}
