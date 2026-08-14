// R17 — an environment-variable layer.
export function envToConfig(env, prefix) {
  const marker = `${prefix}__`;
  const out = {};
  for (const name of Object.keys(env)) {
    if (!name.startsWith(marker)) continue;
    const rest = name.slice(marker.length);
    const sep = rest.indexOf('__');
    if (sep === -1) continue;
    const section = rest.slice(0, sep);
    const key = rest.slice(sep + 2);
    out[section] ??= {};
    out[section][key] = String(env[name]);
  }
  return out;
}
