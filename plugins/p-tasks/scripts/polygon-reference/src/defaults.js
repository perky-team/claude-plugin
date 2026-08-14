// R3 — fill in defaults.
export function applyDefaults(config, schema) {
  // Copy first, so the input is never touched.
  const out = {};
  for (const [section, keys] of Object.entries(config)) out[section] = { ...keys };

  for (const [path, rule] of Object.entries(schema)) {
    if (!('default' in rule)) continue;
    const [section, key] = path.split('.');
    if (out[section]?.[key] !== undefined) continue;
    out[section] ??= {};
    // Defaults run before validation, so they go in as strings.
    out[section][key] = String(rule.default);
  }
  return out;
}
