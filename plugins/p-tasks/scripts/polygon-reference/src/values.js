// R38 — unquote a whole config.
import { unquote } from './quotes.js';

export function unquoteConfig(config) {
  const out = {};
  for (const [section, keys] of Object.entries(config)) {
    out[section] = {};
    for (const [key, value] of Object.entries(keys)) out[section][key] = unquote(value);
  }
  return out;
}
