import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function loadDatabaseSync() {
  try { return require('node:sqlite').DatabaseSync; }
  catch { throw new Error('Node >= 22.5 required for p-graph (node:sqlite unavailable)'); }
}

// 2: Go qnames became package/receiver-qualified (e.g. "filesink.New",
// "filesink.Writer.Write"). The qname format changed, so a DB written by an
// older version must be fully reindexed rather than incrementally patched.
// 3: added the field_types table + edges.field_key/method columns for Go
// struct-field method-call resolution (recv.field.Method()). New columns/table
// only exist after a rebuild, so a stale DB must fully reindex.
// 4: Go grouped `type ( … )` blocks and `type X = Y` aliases now index one node
// per spec with correct pkg-qualified qnames (previously a grouped block dropped
// its whole file or mangled qnames). Existing Go graphs have missing/wrong nodes
// until rebuilt, so bump to force a full reindex. No DDL change — an old DB opens
// read-write cleanly and rebuilds; no read-only degrade.
// 5: a call on the enclosing method's own receiver (`s.M()` in Go, `this.M()` in
// TS/JS/C++, `self.M()` in Python) is now stored receiver-qualified instead of as
// a bare name, so it no longer collides with same-named methods on other types.
// dst_name values changed for those edges — an old DB must fully reindex to pick
// the new resolution up. No DDL change.
export const SCHEMA_VERSION = 5;

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
  src_id TEXT, dst_id TEXT, dst_name TEXT, kind TEXT, file TEXT, line INTEGER,
  field_key TEXT, method TEXT
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS edges_dstname ON edges(dst_name);
CREATE INDEX IF NOT EXISTS edges_file ON edges(file);
CREATE INDEX IF NOT EXISTS edges_fieldkey ON edges(field_key);
-- Struct-field-type table for Go: key "<pkg>.<Struct>.<field>" -> package-
-- qualified field type ('*' stripped), e.g. "events.Server.dimpleCore" ->
-- "core.Core". Lets resolvePending() type a recv.field.Method() call.
CREATE TABLE IF NOT EXISTS field_types (
  key TEXT, type TEXT, file TEXT
);
CREATE INDEX IF NOT EXISTS field_types_key ON field_types(key);
CREATE INDEX IF NOT EXISTS field_types_file ON field_types(file);
`;

export function openStore(dbPath, opts = {}) {
  const DatabaseSync = loadDatabaseSync();
  if (opts.readOnly) return openReadOnly(DatabaseSync, dbPath);
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
    'INSERT INTO edges (src_id,dst_id,dst_name,kind,file,line,field_key,method) VALUES (?,?,?,?,?,?,?,?)');
  const insFieldType = db.prepare('INSERT INTO field_types (key,type,file) VALUES (?,?,?)');
  const delFieldTypesByFile = db.prepare('DELETE FROM field_types WHERE file = ?');
  const insFile = db.prepare(`INSERT INTO files (path,hash,lang,indexed_at)
    VALUES (?,?,?,'') ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, lang=excluded.lang`);
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');
  const insFts = hasFts
    ? db.prepare('INSERT INTO nodes_fts (id,name,qname,signature) VALUES (?,?,?,?)')
    : null;
  const delFtsByFile = hasFts
    ? db.prepare('DELETE FROM nodes_fts WHERE id IN (SELECT id FROM nodes WHERE file = ?)')
    : null;

  // Truncate all graph data (keeps meta: schema_version, created_at).
  // Used by a full reindex so symbols/edges of files deleted since the last
  // index don't survive the rebuild.
  store.clear = () => {
    db.prepare('BEGIN').run();
    try {
      if (hasFts) db.exec('DELETE FROM nodes_fts');
      db.exec('DELETE FROM edges');
      db.exec('DELETE FROM nodes');
      db.exec('DELETE FROM files');
      db.exec('DELETE FROM field_types');
      db.prepare('COMMIT').run();
    } catch (err) { db.prepare('ROLLBACK').run(); throw err; }
  };
  store.upsertFile = (path, hash, lang) => insFile.run(path, hash, lang);
  store.removeFile = (path) => {
    if (delFtsByFile) delFtsByFile.run(path);
    delNodesByFile.run(path);
    delEdgesByFile.run(path);
    delFieldTypesByFile.run(path);
    delFile.run(path);
  };
  store.replaceFileSymbols = (file, nodes, edges, fieldTypes = []) => {
    db.prepare('BEGIN').run();
    try {
      if (delFtsByFile) delFtsByFile.run(file);
      delNodesByFile.run(file);
      delEdgesByFile.run(file);
      delFieldTypesByFile.run(file);
      for (const n of nodes) {
        insNode.run(n.id, n.name, n.qname, n.kind, n.lang, n.file,
          n.start_line, n.end_line, n.signature, n.doc, n.container_id);
        if (insFts) insFts.run(n.id, n.name, n.qname, n.signature);
      }
      for (const e of edges) insEdge.run(e.src_id, e.dst_id ?? null, e.dst_name ?? null, e.kind, e.file, e.line, e.field_key ?? null, e.method ?? null);
      for (const f of fieldTypes) insFieldType.run(f.key, f.type, f.file ?? file);
      db.prepare('COMMIT').run();
    } catch (err) { db.prepare('ROLLBACK').run(); throw err; }
  };

  store.fileHash = (path) =>
    db.prepare('SELECT hash FROM files WHERE path = ?').get(path)?.hash ?? null;
  attachReadHelpers(store, db, hasFts);
  store.resolvePending = () => {
    // Invalidate edges whose resolved target no longer exists (its defining
    // file was reindexed or deleted). Without this an incremental sync keeps a
    // stale dst_id forever, so callers/callees/trace/impact silently drop the
    // edge — diverging from what a full rebuild would produce.
    db.prepare(`
      UPDATE edges SET dst_id = NULL
      WHERE dst_id IS NOT NULL AND dst_id NOT IN (SELECT id FROM nodes)`).run();
    // Pass A — prefer an exact qualified match. A qualified call target like
    // "filesink.New" links straight to the node whose qname is "filesink.New".
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n WHERE n.qname = dst_name LIMIT 1
      )
      WHERE dst_id IS NULL AND dst_name IS NOT NULL
        AND (SELECT count(*) FROM nodes n WHERE n.qname = dst_name) = 1`).run();
    // A field-selector target depends on the field_types table, which can change
    // in a DIFFERENT file than the call site (the struct's field type is edited
    // but the calling method's file isn't reparsed, so its dst_id would go
    // stale). Clear every field-selector edge so Pass F recomputes it from the
    // current field_types. The bare-name fallback (Pass B) re-links any that
    // Pass F can't resolve, so this never loses a legitimately fallback-linked edge.
    db.prepare(`UPDATE edges SET dst_id = NULL WHERE field_key IS NOT NULL`).run();
    // Pass F — Go recv.field.Method() resolution via the field-type table. An
    // edge tagged with field_key ("<pkg>.<Struct>.<field>") + method resolves to
    // the node "<field type>.<method>". This runs BEFORE the bare-name fallback
    // so an ambiguous method name (two types with a same-named method) links to
    // the RIGHT type. Guarded twice — exactly one known field type for the key
    // AND exactly one node with the target qname — so an unknown/ambiguous field
    // type creates no edge and falls through to the bare-name fallback instead.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.qname = (SELECT ft.type FROM field_types ft WHERE ft.key = edges.field_key LIMIT 1) || '.' || edges.method
        LIMIT 1
      )
      WHERE dst_id IS NULL AND field_key IS NOT NULL AND method IS NOT NULL
        AND (SELECT count(DISTINCT ft.type) FROM field_types ft WHERE ft.key = edges.field_key) = 1
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = (SELECT ft.type FROM field_types ft WHERE ft.key = edges.field_key LIMIT 1) || '.' || edges.method) = 1`).run();
    // Pass B — fall back to a unique bare-name match only when no qualified
    // candidate exists (e.g. a method call left bare, or a non-Go language).
    // The "exactly one" guard is preserved: a genuinely ambiguous bare name
    // stays NULL rather than linking to a guessed target (no false edges).
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n WHERE n.name = dst_name LIMIT 1
      )
      WHERE dst_id IS NULL AND dst_name IS NOT NULL
        AND (SELECT count(*) FROM nodes n WHERE n.qname = dst_name) = 0
        AND (SELECT count(*) FROM nodes n WHERE n.name = dst_name) = 1`).run();
    // Pass C — a receiver-qualified guess that missed. `s.M()` / `this.M()` is
    // stored as "<own type>.M", which does not exist when M is inherited or
    // promoted from an embedded type. `method` holds the bare name, so retry the
    // unique-bare-name rule on it; without this the qualified guess would lose
    // edges Pass B used to link.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n WHERE n.name = edges.method LIMIT 1
      )
      WHERE dst_id IS NULL AND method IS NOT NULL
        AND (SELECT count(*) FROM nodes n WHERE n.name = edges.method) = 1`).run();
  };
  store.markSchemaCurrent = () => store.setMeta('schema_version', SCHEMA_VERSION);

  if (store.getMeta('schema_version') === null) {
    store.setMeta('schema_version', SCHEMA_VERSION);
    store.setMeta('created_at', '');
  }
  return store;
}

// Read/query helpers shared by the read-write and read-only stores.
function attachReadHelpers(store, db, hasFts) {
  store.search = (query, { kind, lang } = {}) => {
    const q = String(query);
    let rows = [];
    if (hasFts) {
      const expr = q.trim().split(/\s+/).filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
      if (expr) {
        rows = db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.id
                           WHERE nodes_fts MATCH ?`).all(expr);
      }
    }
    if (!hasFts || rows.length === 0) {
      const like = `%${q}%`;
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
  store.files = (prefix) => {
    let p = prefix == null ? '' : String(prefix);
    if (p === '.' || p === './') p = '';
    else if (p.startsWith('./')) p = p.slice(2);
    return db.prepare(`
      SELECT file AS path, count(*) AS symbols FROM nodes
      WHERE file = ? OR file LIKE ? GROUP BY file ORDER BY file`).all(p, `${p}%`);
  };
  store.status = () => ({
    nodes: db.prepare('SELECT count(*) c FROM nodes').get().c,
    edges: db.prepare('SELECT count(*) c FROM edges').get().c,
    call_edges: db.prepare(`SELECT count(*) c FROM edges WHERE kind = 'call'`).get().c,
    unresolved_calls: db.prepare(
      `SELECT count(*) c FROM edges WHERE kind = 'call' AND dst_id IS NULL`).get().c,
    files: db.prepare('SELECT count(*) c FROM files').get().c,
    indexed_sha: store.getMeta('indexed_sha'),
    schema_version: store.getMeta('schema_version'),
    fts: hasFts,
  });

  // Where the graph gave up. A call edge with no dst_id is a call site pgraph
  // could not attribute to exactly one symbol: an ambiguous bare name, a
  // receiver it cannot type (interface, parameter, local, long field chain), or
  // a call into the stdlib / a third-party package. Every query walks resolved
  // edges only, so without these reports a dropped call site is
  // indistinguishable from "nothing calls this" — the graph would answer with
  // silent holes. Reporting them turns a silent hole into a stated one.
  const unresolvedByNames = (names) => {
    const list = [...new Set(names.filter(Boolean).map(String))];
    if (!list.length) return [];
    const rows = [];
    // Chunked so a large impact set can't blow SQLite's bound-parameter limit.
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      rows.push(...db.prepare(`
        SELECT e.dst_name, e.file, e.line, s.qname AS src_qname
        FROM edges e LEFT JOIN nodes s ON s.id = e.src_id
        WHERE e.kind = 'call' AND e.dst_id IS NULL
          AND e.dst_name IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
    }
    return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };
  // A call site carries whatever the source wrote — usually the bare method
  // name, even when the user asks by qname. Match on both.
  const targetNames = (nameOrId) => {
    const n = store.node(nameOrId);
    return n ? [String(nameOrId), n.name, n.qname] : [String(nameOrId)];
  };
  store.unresolvedFor = (name) => unresolvedByNames(targetNames(name));
  store.unresolvedFrom = (name) => {
    const n = store.node(name);
    if (!n) return [];
    return db.prepare(`
      SELECT dst_name, file, line FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND src_id = ?
      ORDER BY file, line`).all(n.id);
  };
  // The frontier of an impact walk: gaps naming the target itself AND gaps
  // naming anything the walk already reached, which is where it stopped.
  store.unresolvedAround = (name) => unresolvedByNames([
    ...targetNames(name),
    ...store.impact(name).flatMap((n) => [n.name, n.qname]),
  ]);
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
  store.schemaStale = () => Number(store.getMeta('schema_version')) !== SCHEMA_VERSION;
}

// Open an already-initialized DB for reads only — no WAL pragma, no DDL, no FTS
// creation, no meta writes (all of which would fail on a read-only handle).
// Used as a fallback when the normal (writable, WAL) open fails, e.g. on a
// read-only filesystem, so a query can still answer (and the refresh degrades).
function openReadOnly(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let hasFts = false;
  try { db.prepare('SELECT 1 FROM nodes_fts LIMIT 1').get(); hasFts = true; } catch { hasFts = false; }

  const readOnlyError = () => { throw new Error('p-graph: store is read-only'); };
  const store = {
    db, hasFts,
    getMeta: (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    fileHash: (path) => db.prepare('SELECT hash FROM files WHERE path = ?').get(path)?.hash ?? null,
    close: () => db.close(),
    setMeta: readOnlyError, clear: readOnlyError, upsertFile: readOnlyError,
    removeFile: readOnlyError, replaceFileSymbols: readOnlyError,
    resolvePending: readOnlyError, markSchemaCurrent: readOnlyError,
  };
  attachReadHelpers(store, db, hasFts);
  return store;
}
