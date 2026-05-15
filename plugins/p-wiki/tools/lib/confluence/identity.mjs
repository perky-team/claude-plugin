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
  const map = new Map();
  const key = (t, s) => `${t}/${s}`;
  return {
    get(type, slug) { return map.get(key(type, slug)); },
    set(type, slug, id) { map.set(key(type, slug), id); },
    clear() { map.clear(); },
  };
}
