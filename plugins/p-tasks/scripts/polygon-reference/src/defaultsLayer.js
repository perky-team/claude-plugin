// R19 — schema defaults as a layer.
import { splitPath } from './paths.js';

export function defaultsAsLayer(schema) {
  const out = {};
  for (const [path, rule] of Object.entries(schema)) {
    if (!('default' in rule)) continue;
    const [section, key] = splitPath(path);
    out[section] ??= {};
    // Same stringification R3's applyDefaults uses (see R16).
    out[section][key] = String(rule.default);
  }
  return out;
}
