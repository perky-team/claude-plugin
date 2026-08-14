// R18 — an include-by-name layer.
import { parseIni } from './parse.js';
import { mergeLayers } from './merge.js';

export function resolveIncludes(config, files) {
  const name = config['']?.include;
  if (name === undefined) {
    // Copy, never mutate — same rule as R4.
    const out = {};
    for (const [section, keys] of Object.entries(config)) out[section] = { ...keys };
    return out;
  }

  if (!Object.hasOwn(files, name)) throw new SyntaxError(`no such include: ${name}`);

  const included = parseIni(files[name]);
  const merged = mergeLayers([included, config]);
  const { include, ...rest } = merged[''] ?? {};
  // Drop '' entirely once it holds nothing but the include key, so a config
  // with no other top-level keys comes back exactly as parseIni would have
  // produced it (no key never gets a bare `{}` entry either — see R1).
  if (Object.keys(rest).length === 0) delete merged[''];
  else merged[''] = rest;
  return merged;
}
