const PATH_RE = /^confluence:\/\/([a-z]+)\/(.+)$/;

export function parsePath(path) {
  const m = PATH_RE.exec(path);
  if (!m) throw new Error(`not a confluence:// path: ${path}`);
  return { type: m[1], slug: m[2] };
}

export function formatPath(type, slug) {
  return `confluence://${type}/${slug}`;
}

export function createIdentityCache() {
  const forward = new Map();         // "<type>/<slug>" → numericId
  const reverse = new Map();         // numericId (string) → { type, slug }
  const fkey = (t, s) => `${t}/${s}`;
  return {
    get(type, slug) { return forward.get(fkey(type, slug)); },
    set(type, slug, id) {
      const k = fkey(type, slug);
      const prev = forward.get(k);
      if (prev !== undefined) reverse.delete(String(prev));
      if (id === undefined) {
        forward.delete(k);
      } else {
        forward.set(k, id);
        reverse.set(String(id), { type, slug });
      }
    },
    drop(type, slug) {
      const k = fkey(type, slug);
      const prev = forward.get(k);
      if (prev !== undefined) reverse.delete(String(prev));
      forward.delete(k);
    },
    getByNumericId(id) { return reverse.get(String(id)); },
    clear() { forward.clear(); reverse.clear(); },
  };
}
