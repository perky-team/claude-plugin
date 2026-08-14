// R2 — check a value against a schema.
const asNumber = (v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function validate(config, schema) {
  const value = {};
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    const [section, key] = path.split('.');
    const raw = config[section]?.[key];
    if (raw === undefined) {
      if (rule.required) errors.push({ path, message: 'is required' });
      continue;
    }
    let out = raw;
    if (rule.type === 'number') {
      out = asNumber(raw);
      if (out === null) { errors.push({ path, message: 'must be a number' }); continue; }
    }
    if (rule.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') {
        errors.push({ path, message: 'must be true or false' });
        continue;
      }
      out = raw === 'true';
    }
    value[section] ??= {};
    value[section][key] = out;
  }
  // Plain string compare, not `localeCompare` — the order must not depend on
  // the machine's locale.
  errors.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
