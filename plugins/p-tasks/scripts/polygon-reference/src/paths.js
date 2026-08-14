// R11 — split a path on its last dot.
export function splitPath(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) throw new TypeError(`bad path: ${path}`);
  return [path.slice(0, dot), path.slice(dot + 1)];
}

export function joinPath(section, key) {
  return section === '' ? key : `${section}.${key}`;
}
