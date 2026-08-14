// R37 — unquote one value.
export function unquote(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  // The only escape this format has. A lone `\` before anything else,
  // including another `\`, is left exactly as it is.
  return value.slice(1, -1).replaceAll('\\"', '"');
}
