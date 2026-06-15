import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function loadDatabaseSync() {
  try { return require('node:sqlite').DatabaseSync; }
  catch { throw new Error('Node >= 22.5 required for p-graph (node:sqlite unavailable)'); }
}

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, hash TEXT, lang TEXT, indexed_at TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT, qname TEXT, kind TEXT, lang TEXT,
  file TEXT, start_line INTEGER, end_line INTEGER,
  signature TEXT, doc TEXT, container_id TEXT
);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_qname ON nodes(qname);
CREATE TABLE IF NOT EXISTS edges (
  src_id TEXT, dst_id TEXT, dst_name TEXT, kind TEXT, file TEXT, line INTEGER
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS edges_dstname ON edges(dst_name);
CREATE INDEX IF NOT EXISTS edges_file ON edges(file);
`;

export function openStore(dbPath) {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(DDL);

  let hasFts = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED, name, qname, signature)`);
    hasFts = true;
  } catch { hasFts = false; }

  const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMetaStmt = db.prepare(
    'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

  const store = {
    db, hasFts,
    getMeta(key) { return getMetaStmt.get(key)?.value ?? null; },
    setMeta(key, value) { setMetaStmt.run(key, String(value)); },
    close() { db.close(); },
  };

  const insNode = db.prepare(`INSERT INTO nodes
    (id,name,qname,kind,lang,file,start_line,end_line,signature,doc,container_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, qname=excluded.qname, kind=excluded.kind, lang=excluded.lang,
      file=excluded.file, start_line=excluded.start_line, end_line=excluded.end_line,
      signature=excluded.signature, doc=excluded.doc, container_id=excluded.container_id`);
  const delNodesByFile = db.prepare('DELETE FROM nodes WHERE file = ?');
  const delEdgesByFile = db.prepare('DELETE FROM edges WHERE file = ?');
  const insEdge = db.prepare(
    'INSERT INTO edges (src_id,dst_id,dst_name,kind,file,line) VALUES (?,?,?,?,?,?)');
  const insFile = db.prepare(`INSERT INTO files (path,hash,lang,indexed_at)
    VALUES (?,?,?,'') ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, lang=excluded.lang`);
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');
  const insFts = hasFts
    ? db.prepare('INSERT INTO nodes_fts (id,name,qname,signature) VALUES (?,?,?,?)')
    : null;
  const delFtsByFile = hasFts
    ? db.prepare('DELETE FROM nodes_fts WHERE id IN (SELECT id FROM nodes WHERE file = ?)')
    : null;

  store.upsertFile = (path, hash, lang) => insFile.run(path, hash, lang);
  store.removeFile = (path) => {
    if (delFtsByFile) delFtsByFile.run(path);
    delNodesByFile.run(path);
    delEdgesByFile.run(path);
    delFile.run(path);
  };
  store.replaceFileSymbols = (file, nodes, edges) => {
    db.prepare('BEGIN').run();
    try {
      if (delFtsByFile) delFtsByFile.run(file);
      delNodesByFile.run(file);
      delEdgesByFile.run(file);
      for (const n of nodes) {
        insNode.run(n.id, n.name, n.qname, n.kind, n.lang, n.file,
          n.start_line, n.end_line, n.signature, n.doc, n.container_id);
        if (insFts) insFts.run(n.id, n.name, n.qname, n.signature);
      }
      for (const e of edges) insEdge.run(e.src_id, e.dst_id ?? null, e.dst_name ?? null, e.kind, e.file, e.line);
      db.prepare('COMMIT').run();
    } catch (err) { db.prepare('ROLLBACK').run(); throw err; }
  };

  store.search = (query, { kind, lang } = {}) => {
    let rows;
    if (hasFts) {
      const phrase = `"${String(query).replace(/"/g, '""')}"`;
      rows = db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.id
                         WHERE nodes_fts MATCH ?`).all(phrase);
    } else {
      const like = `%${query}%`;
      rows = db.prepare(`SELECT * FROM nodes WHERE name LIKE ? OR qname LIKE ?`).all(like, like);
    }
    return rows.filter((r) => (!kind || r.kind === kind) && (!lang || r.lang === lang)).slice(0, 100);
  };
  store.node = (idOrQname) =>
    db.prepare('SELECT * FROM nodes WHERE id = ? OR qname = ? LIMIT 1').get(idOrQname, idOrQname) ?? null;
  store.callers = (name) => db.prepare(`
    SELECT DISTINCT s.* FROM edges e JOIN nodes s ON s.id = e.src_id
    JOIN nodes d ON d.id = e.dst_id WHERE d.name = ? OR d.qname = ?`).all(name, name);
  store.callees = (name) => db.prepare(`
    SELECT DISTINCT d.* FROM edges e JOIN nodes s ON s.id = e.src_id
    JOIN nodes d ON d.id = e.dst_id WHERE s.name = ? OR s.qname = ?`).all(name, name);
  store.files = (prefix) => db.prepare(`
    SELECT file AS path, count(*) AS symbols FROM nodes
    WHERE file = ? OR file LIKE ? GROUP BY file ORDER BY file`).all(prefix, `${prefix}%`);
  store.status = () => ({
    nodes: db.prepare('SELECT count(*) c FROM nodes').get().c,
    edges: db.prepare('SELECT count(*) c FROM edges').get().c,
    files: db.prepare('SELECT count(*) c FROM files').get().c,
    indexed_sha: store.getMeta('indexed_sha'),
    schema_version: store.getMeta('schema_version'),
    fts: hasFts,
  });

  const MAX_DEPTH = 50;
  store.impact = (name) => {
    const target = store.node(name);
    if (!target) return [];
    return db.prepare(`
      WITH RECURSIVE up(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e.src_id, up.depth + 1 FROM edges e
        JOIN up ON e.dst_id = up.id
        WHERE up.depth < ${MAX_DEPTH} AND e.src_id IS NOT NULL
      )
      SELECT DISTINCT n.* FROM nodes n JOIN up ON n.id = up.id WHERE n.id != ?`).all(target.id, target.id);
  };
  store.trace = (fromName, toName) => {
    const from = store.node(fromName), to = store.node(toName);
    if (!from || !to) return null;
    const edges = db.prepare('SELECT src_id, dst_id FROM edges WHERE dst_id IS NOT NULL').all();
    const next = new Map();
    for (const e of edges) {
      if (!next.has(e.src_id)) next.set(e.src_id, []);
      next.get(e.src_id).push(e.dst_id);
    }
    const q = [[from.id]], seen = new Set([from.id]);
    while (q.length) {
      const path = q.shift();
      const last = path[path.length - 1];
      if (last === to.id) return path.map((id) => store.node(id).qname);
      for (const nx of next.get(last) ?? []) {
        if (!seen.has(nx)) { seen.add(nx); q.push([...path, nx]); }
      }
    }
    return null;
  };
  store.resolvePending = () => {
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n WHERE (n.qname = dst_name OR n.name = dst_name) LIMIT 1
      )
      WHERE dst_id IS NULL AND dst_name IS NOT NULL
        AND (SELECT count(DISTINCT n.id) FROM nodes n WHERE n.qname = dst_name OR n.name = dst_name) = 1`).run();
  };

  if (store.getMeta('schema_version') === null) {
    store.setMeta('schema_version', SCHEMA_VERSION);
    store.setMeta('created_at', '');
  }
  return store;
}
