// R8 — print as JSON.
const sortDeep = (v) => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const key of Object.keys(v).sort()) out[key] = sortDeep(v[key]);
  return out;
};

export function toJson(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}
