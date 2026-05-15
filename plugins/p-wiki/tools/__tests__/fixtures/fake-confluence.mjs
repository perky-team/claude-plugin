export function createFakeConfluence({ spaces = [], initialPages = [] } = {}) {
  let nextPageId = 1000;
  let nextPropId = 1;
  const pageById = new Map();
  for (const p of initialPages) pageById.set(p.id, normalizePage(p));

  function normalizePage(p) {
    return {
      id: String(p.id),
      title: p.title,
      parentId: p.parentId ? String(p.parentId) : null,
      version: p.version ?? 1,
      body: p.body ?? { type: 'doc', version: 1, content: [] },
      properties: new Map((p.properties ?? []).map(pr => [pr.key, { id: String(pr.id ?? nextPropId++), key: pr.key, value: pr.value, version: pr.version ?? 1 }])),
      labels: new Set(p.labels ?? []),
    };
  }

  function isAncestor(pageId, candidateAncestorId) {
    let cur = pageById.get(pageId);
    while (cur) {
      if (cur.parentId === candidateAncestorId) return true;
      cur = pageById.get(cur.parentId);
    }
    return false;
  }

  // Naive CQL: supports `text ~ "x"`, `ancestor = N`, `property["k"] = "v"`, `labels = "v"`, AND, OR, parens.
  function cqlMatches(page, cql) {
    const body = page.body?.content ? JSON.stringify(page.body.content).toLowerCase() : '';
    const titleAndBody = (page.title + ' ' + body).toLowerCase();
    let expr = cql;
    expr = expr.replace(/text\s*~\s*"([^"]+)"/g, (_, q) => titleAndBody.includes(q.toLowerCase()) ? 'true' : 'false');
    expr = expr.replace(/ancestor\s*=\s*(\d+)/g, (_, a) => (isAncestor(page.id, String(a)) || page.parentId === String(a)) ? 'true' : 'false');
    expr = expr.replace(/property\["([^"]+)"\]\s*=\s*"([^"]+)"/g, (_, k, v) => page.properties.get(k)?.value === v ? 'true' : 'false');
    expr = expr.replace(/property\["([^"]+)"\]\s*IS\s+NOT\s+EMPTY/gi, (_, k) => page.properties.has(k) ? 'true' : 'false');
    expr = expr.replace(/labels\s*=\s*"([^"]+)"/g, (_, l) => page.labels.has(l) ? 'true' : 'false');
    expr = expr.replace(/id\s*!=\s*(\d+)/g, (_, id) => page.id !== String(id) ? 'true' : 'false');
    expr = expr.replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||');
    try { return Function('"use strict";return (' + expr + ')')(); } catch { return false; }
  }

  async function transport(req) {
    const { method, path, body: rawBody } = req;
    const body = rawBody === undefined ? undefined : JSON.parse(rawBody);

    // ----- spaces -----
    let m;
    if (method === 'GET' && (m = /^\/wiki\/api\/v2\/spaces(?:\?keys=([^&]+))?/.exec(path))) {
      const key = m[1] ? decodeURIComponent(m[1]) : null;
      const results = key ? spaces.filter(s => s.key === key) : spaces;
      return { status: 200, body: { results } };
    }

    // ----- pages -----
    if (method === 'POST' && path === '/wiki/api/v2/pages') {
      const id = String(nextPageId++);
      const adfValue = typeof body.body.value === 'string' ? JSON.parse(body.body.value) : body.body.value;
      pageById.set(id, { id, title: body.title, parentId: String(body.parentId), version: 1, body: adfValue, properties: new Map(), labels: new Set() });
      return { status: 200, body: { id, title: body.title, version: { number: 1 } } };
    }
    if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)(\?.*)?$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'GET') {
        return { status: 200, body: { id: p.id, title: p.title, parentId: p.parentId, version: { number: p.version }, body: { atlas_doc_format: { value: JSON.stringify(p.body) } } } };
      }
      if (method === 'PUT') {
        const adfValue = typeof body.body.value === 'string' ? JSON.parse(body.body.value) : body.body.value;
        if (body.version.number !== p.version + 1) return { status: 409, body: { message: 'version conflict' } };
        p.version = body.version.number;
        p.title = body.title ?? p.title;
        p.parentId = body.parentId ? String(body.parentId) : p.parentId;
        p.body = adfValue;
        return { status: 200, body: { id: p.id, version: { number: p.version } } };
      }
      if (method === 'DELETE') { pageById.delete(p.id); return { status: 204 }; }
    }

    // ----- properties -----
    if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)\/properties$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'GET') {
        return { status: 200, body: { results: [...p.properties.values()].map(pr => ({ id: pr.id, key: pr.key, value: pr.value, version: { number: pr.version } })) } };
      }
      if (method === 'POST') {
        if (p.properties.has(body.key)) return { status: 400, body: { message: 'key already exists' } };
        const id = String(nextPropId++);
        p.properties.set(body.key, { id, key: body.key, value: body.value, version: 1 });
        return { status: 200, body: { id, key: body.key, value: body.value, version: { number: 1 } } };
      }
    }
    if ((m = /^\/wiki\/api\/v2\/pages\/(\d+)\/properties\/(\w+)$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'PUT') {
        for (const [k, pr] of p.properties) {
          if (pr.id === m[2]) {
            pr.value = body.value;
            pr.version = body.version.number;
            return { status: 200, body: { id: pr.id, key: k, value: pr.value, version: { number: pr.version } } };
          }
        }
        return { status: 404 };
      }
      if (method === 'DELETE') {
        for (const [k, pr] of p.properties) {
          if (pr.id === m[2]) { p.properties.delete(k); return { status: 204 }; }
        }
        return { status: 404 };
      }
    }

    // ----- search (v1 CQL) -----
    if (method === 'GET' && (m = /^\/wiki\/rest\/api\/search\?cql=([^&]+)/.exec(path))) {
      const cql = decodeURIComponent(m[1]);
      const results = [];
      for (const p of pageById.values()) {
        if (cqlMatches(p, cql)) results.push({ content: { id: p.id, title: p.title }, excerpt: '', score: 1 });
      }
      return { status: 200, body: { results, totalSize: results.length } };
    }

    // ----- labels (v1) -----
    if ((m = /^\/wiki\/rest\/api\/content\/(\d+)\/label(\?name=(.+))?$/.exec(path))) {
      const p = pageById.get(m[1]);
      if (!p) return { status: 404 };
      if (method === 'GET') return { status: 200, body: { results: [...p.labels].map(name => ({ name })) } };
      if (method === 'POST') { for (const t of body ?? []) p.labels.add(t.name); return { status: 200, body: {} }; }
      if (method === 'DELETE') { p.labels.delete(decodeURIComponent(m[3])); return { status: 204 }; }
    }

    return { status: 404, body: { message: `unhandled ${method} ${path}` } };
  }

  return { transport, pageById, spaces };
}
