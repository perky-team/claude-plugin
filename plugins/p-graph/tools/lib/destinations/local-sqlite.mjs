import { createRequire } from 'node:module';
import { OWNER_KINDS_SQL } from '../owner-kinds.mjs';
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
// 6: edges gained dst_bare/lang/external, and field_types gained "#embed" rows.
// These are new columns, which CREATE TABLE IF NOT EXISTS can never add to an
// existing table, so openStore now drops the graph tables when the stored version
// is older. The DB is a rebuildable cache; dropping it costs one reindex.
// 7: a Go method on a generic type is now receiver-qualified (`cache.Partition.Clear`,
// previously `cache.Clear`), and an import path ending in `/vN` now registers the
// right package name. Both change stored qnames and dst_name values, so an older
// graph must be rebuilt rather than patched. This bump also adds edges.guess (set
// when a target was found only by a unique bare name) and edges.member (set when
// the call was written as a member access) — later tasks fill them, and a column
// added after this bump would be missing on an already-migrated graph.
export const SCHEMA_VERSION = 7;

const META_DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const DDL = `
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
  field_key TEXT, method TEXT, dst_bare TEXT, lang TEXT, external INTEGER DEFAULT 0,
  guess INTEGER DEFAULT 0, member INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS edges_dstname ON edges(dst_name);
CREATE INDEX IF NOT EXISTS edges_dstbare ON edges(dst_bare);
CREATE INDEX IF NOT EXISTS edges_file ON edges(file);
CREATE INDEX IF NOT EXISTS edges_fieldkey ON edges(field_key);
-- Struct-field-type table for Go: key "<pkg>.<Struct>.<field>" -> package-
-- qualified field type ('*' stripped), e.g. "events.Server.dimpleCore" ->
-- "core.Core". The key "<pkg>.<Struct>#embed" holds an embedded type instead.
CREATE TABLE IF NOT EXISTS field_types (
  key TEXT, type TEXT, file TEXT
);
CREATE INDEX IF NOT EXISTS field_types_key ON field_types(key);
CREATE INDEX IF NOT EXISTS field_types_file ON field_types(file);
`;

// The rule for a call the source wrote ON something (`x.end()`): its target must
// be a member of a type. `edges.member` says the call was a member access, and
// the target's own owner says whether it can be reached that way.
//
// This is what stops one ten-line arrow function named `end`, declared inside a
// single method body, from answering all 825 `.end()` calls in a repo: its owner
// is that method, not a type, so no member call can reach it.
//
// Go is exempt. Go writes a package call as a member access too (`fmt.Println`),
// and a Go method node is declared at file top level, so it has no owner in the
// graph — it carries the package and the receiver type in its qname instead.
// A Go member call is therefore already narrowed by the qname itself, and
// asking for an owner here would refuse every Go call.
//
// `n` is the candidate node the surrounding statement is testing.
//
// Every pass applies this ON TOP of its own uniqueness guard, never inside it.
// Filtering a candidate count would let this rule CREATE links: a bare name
// shared by two symbols is ambiguous today, and dropping one of them for failing
// the owner rule would leave a single "unique" match. On flask that turned 0
// edges into 36 false ones — every `dict.setdefault(...)` call in the repo landed
// on the one class method named setdefault. This rule may only remove a link.
//
// "Is this candidate a member a dot or an arrow can reach?" Two ways to be one:
//
//  1. the node sits inside an owner in its own file — the normal case, and the
//     only one for a language whose qname comes from lexical nesting;
//  2. the node's own qname names the owner. C++ defines a method outside its
//     class (`std::string PgStore::Get(int)` in the .cpp, `class PgStore` in the
//     .h), so it has no owner in its own file and rule 1 can never see one. The
//     qname says `PgStore.Get` because the source wrote `PgStore::`, and the
//     owner is checked against a class this repo really indexed — so this is a
//     recorded fact, not a guess. It changes nothing for the other languages:
//     there, the qname prefix IS the container, so rule 1 already answered.
//
// A C++ namespace is excluded, unlike a TypeScript one. `namespace X { void f(); }`
// is reached by writing `X::f()`, never `x.f()`, so a dot in C++ can only mean a
// call on a value — and letting it match every free function in a repo that wraps
// its code in one namespace is exactly the kind of false edge this rule removes.
//
// `langCol` names the column holding the call's language, because the two readers
// below have different rows in scope.
const memberOwnerSql = (langCol) => `(
  EXISTS (SELECT 1 FROM nodes own WHERE own.id = n.container_id
            AND own.kind IN ${OWNER_KINDS_SQL}
            AND (own.kind <> 'namespace' OR ${langCol} <> 'cpp'))
  OR EXISTS (SELECT 1 FROM nodes own WHERE own.lang = n.lang
            AND own.qname = substr(n.qname, 1, length(n.qname) - length(n.name) - 1)
            AND own.kind IN ${OWNER_KINDS_SQL}
            AND (own.kind <> 'namespace' OR ${langCol} <> 'cpp')))`;
const MEMBER_TARGET_OK =
  `(edges.member = 0 OR edges.lang = 'go' OR ${memberOwnerSql('edges.lang')})`;

export function openStore(dbPath, opts = {}) {
  const DatabaseSync = loadDatabaseSync();
  if (opts.readOnly) return openReadOnly(DatabaseSync, dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(META_DDL);
  // A schema bump can add columns, and CREATE TABLE IF NOT EXISTS will not add
  // them to a table that already exists — a prepared statement would then fail on
  // a missing column and take the whole CLI down. The graph is a rebuildable
  // cache, so drop it and let the next index refill it. The stored schema_version
  // is left as-is (not bumped, not cleared) here: ensureFresh() drives the real
  // rebuild off it still reading stale, and only markSchemaCurrent() — called
  // after that rebuild actually repopulates the tables — is allowed to raise it.
  // Bumping it in openStore would make an empty, just-dropped graph look current.
  const storedVersion = Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value);
  if (storedVersion && storedVersion < SCHEMA_VERSION) {
    for (const t of ['nodes_fts', 'edges', 'nodes', 'files', 'field_types']) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
  }
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
    `INSERT INTO edges (src_id,dst_id,dst_name,kind,file,line,field_key,method,dst_bare,lang,external,member)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      for (const e of edges) insEdge.run(e.src_id, e.dst_id ?? null, e.dst_name ?? null,
        e.kind, e.file, e.line, e.field_key ?? null, e.method ?? null,
        e.dst_bare ?? null, e.lang ?? null, e.external ?? 0, e.member ?? 0);
      for (const f of fieldTypes) insFieldType.run(f.key, f.type, f.file ?? file);
      db.prepare('COMMIT').run();
    } catch (err) { db.prepare('ROLLBACK').run(); throw err; }
  };

  store.fileHash = (path) =>
    db.prepare('SELECT hash FROM files WHERE path = ?').get(path)?.hash ?? null;
  attachReadHelpers(store, db, hasFts);
  // Pass C — a receiver-qualified guess that missed. `s.M()` is stored as
  // "<own type>.M"; when no such node exists, M is inherited or promoted. Falling
  // back to a unique bare name is right for real promotion and wrong when the
  // type only embeds something external (`struct{ sync.Mutex }` then `s.Lock()`)
  // or embeds nothing at all (`unlock` is a func-typed field, not a method). Go
  // records what it embeds, so require an embedded repo type there. Other
  // languages do not index inheritance, so they keep the plain fallback — that is
  // what links Python's `self._find_error_handler` to the base class.
  const resolveOwnReceiverFallback = () => {
    const candidates = db.prepare(`
      SELECT rowid, dst_name, dst_bare, lang, member FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND external = 0
        AND method IS NOT NULL AND field_key IS NULL AND dst_bare IS NOT NULL`).all();
    if (!candidates.length) return;
    // An embedded interface is not proof of promotion: which implementation
    // runs is decided at runtime (the Go decorator pattern), so only a
    // concrete embedded type counts.
    const embedsRepoType = db.prepare(`
      SELECT 1 FROM field_types ft JOIN nodes n ON n.qname = ft.type
      WHERE ft.key = ? AND n.kind <> 'interface' LIMIT 1`);
    // `owned` says whether the candidate is a member of a type, which is what a
    // call written on something can reach. Selected next to the hit rather than
    // filtered in the WHERE, so it can only reject the one hit this pass found —
    // never turn two ambiguous hits into one (see MEMBER_TARGET_OK).
    const byBareName = db.prepare(`
      SELECT n.id, ${memberOwnerSql('n.lang')} AS owned
      FROM nodes n
      WHERE n.name = ? AND n.lang = ? AND n.kind IN ('function','method','class') LIMIT 2`);
    // Promotion is real (Go lets an embedded type's method answer for the
    // outer one), but WHICH bare-name node it lands on is still a guess: the
    // receiver-qualified name missed, and the fallback picks the one repo
    // symbol that happens to share the bare method name.
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 1 WHERE rowid = ?');
    for (const e of candidates) {
      const owner = e.dst_name.slice(0, Math.max(0, e.dst_name.length - e.dst_bare.length - 1));
      if (e.lang === 'go' && !(owner && embedsRepoType.get(`${owner}#embed`))) continue;
      const hits = byBareName.all(e.dst_bare, e.lang);
      if (hits.length !== 1) continue;
      // `this.m()` / `self.m()` is written on something, so its target must be a
      // member of a type — not a module-level function that happens to share the
      // name. Go is exempt for the reason given on MEMBER_TARGET_OK.
      if (e.member === 1 && e.lang !== 'go' && !hits[0].owned) continue;
      setDst.run(hits[0].id, e.rowid);
    }
  };

  store.resolvePending = () => {
    // Only these kinds can be the target of a call. A Go conversion
    // (`Duration(v)`) parses as a call but names a type, and a call edge into a
    // type node makes callers/impact report a caller that does not exist.
    // `class` stays in: `new Service()` in TS and a C++ constructor call really
    // do target one.
    const CALLABLE = `('function','method','class')`;
    // Invalidate every call edge and resolve from scratch. A resolved edge can
    // become ambiguous when a new same-named symbol appears, so keeping it would
    // make an incremental index answer differently from a full rebuild —
    // silently, and in the direction of false confidence.
    // guess is cleared with dst_id: a re-resolve must not let a stale 1 from a
    // previous index survive on an edge that this pass now resolves for real.
    db.prepare(`UPDATE edges SET dst_id = NULL, guess = 0 WHERE kind = 'call'`).run();

    // Pass A — exact qualified match. "filesink.New" links to the node whose
    // qname is "filesink.New", in the same language, and only when it is unique.
    // A qualified name is not a guess: the call site itself named the package
    // or type, so this is as certain as a resolver gets.
    // The SET picks the same row the WHERE guard vouched for, owner rule
    // included. Today the count guard below already pins the candidate set to one
    // row, so this changes nothing — but if that guard is ever loosened, a SET
    // without the condition would happily store a node the WHERE just refused.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.qname = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
          AND ${MEMBER_TARGET_OK}
        LIMIT 1
      ), guess = 0
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}) = 1
        AND EXISTS (SELECT 1 FROM nodes n
             WHERE n.qname = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
               AND ${MEMBER_TARGET_OK})`).run();

    // Pass F — Go recv.field.Method() through the field-type table. Runs before
    // the bare-name fallback so an ambiguous method name links to the RIGHT type.
    // Guarded twice: exactly one known field type for the key, and exactly one
    // node with the target qname. The receiver's type was read from the source
    // (a struct field, a parameter, or a variable declaration), so this is a
    // recorded fact, not a guess.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.qname = (SELECT ft.type FROM field_types ft WHERE ft.key = edges.field_key LIMIT 1) || '.' || edges.method
          AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
        LIMIT 1
      ), guess = 0
      WHERE kind = 'call' AND dst_id IS NULL AND field_key IS NOT NULL AND method IS NOT NULL
        AND (SELECT count(DISTINCT ft.type) FROM field_types ft WHERE ft.key = edges.field_key) = 1
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = (SELECT ft.type FROM field_types ft WHERE ft.key = edges.field_key LIMIT 1) || '.' || edges.method
               AND n.lang = edges.lang AND n.kind IN ${CALLABLE}) = 1`).run();

    // Pass B — a unique bare-name match, only when no qualified candidate exists.
    // The extra guard is the one the evaluation showed missing: a call through a
    // field must not fall back to an unrelated same-named method just because
    // Pass F's exact `<type>.<method>` lookup failed. The only other legitimate
    // target is a method PROMOTED into the field's type from an embedded repo
    // type — the same rule Pass C applies to a call on the method's own
    // receiver. So when the field's type is known, require it to embed a repo
    // type (a `"<type>#embed"` row pointing at a node that exists); otherwise
    // refuse. This also covers a field typed as a repo-defined interface: the
    // interface node exists, so the old "is it a repo type" check let it through,
    // but an interface embeds nothing and has no method_declaration nodes of its
    // own, so it can never supply a legitimate target. Linking the bare name to
    // the one repo method that shares it produced 13 false callers for a single
    // symbol in hugo.
    // A bare name is not a fact about the receiver's type — it is a guess that
    // the one repo symbol with this name is the one the call site meant.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.name = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
          AND ${MEMBER_TARGET_OK}
        LIMIT 1
      ), guess = 1
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND (SELECT count(*) FROM nodes n WHERE n.qname = edges.dst_name AND n.lang = edges.lang) = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.name = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}) = 1
        AND EXISTS (SELECT 1 FROM nodes n
             WHERE n.name = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
               AND ${MEMBER_TARGET_OK})
        AND NOT EXISTS (
          SELECT 1 FROM field_types ft
          WHERE ft.key = edges.field_key
            AND NOT EXISTS (
              -- An embedded interface is not proof of promotion either: the Go
              -- decorator pattern embeds the interface, and which
              -- implementation answers the call is a runtime decision.
              SELECT 1 FROM field_types emb JOIN nodes en ON en.qname = emb.type
              WHERE emb.key = ft.type || '#embed' AND en.kind <> 'interface'))`).run();

    resolveOwnReceiverFallback();
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
  // A writable open always has edges.guess by the time this runs: either the
  // table was just recreated by the DDL (fresh column) or the stored schema
  // was already 7+ (guess already there). The one way to reach this function
  // WITHOUT that column is the read-only fallback on a pre-7 DB that a
  // writable open never got the chance to migrate (e.g. a read-only
  // filesystem). Detect that once, the same way hasFts is detected, and treat
  // every edge in such a DB as certain — the honest reading of "guess" on
  // data written before this column had any meaning.
  let hasGuess = true;
  try { db.prepare('SELECT guess FROM edges LIMIT 1').get(); } catch { hasGuess = false; }
  const GUESS_COL = hasGuess ? 'MIN(e.guess)' : '0';
  const GUESS_FILTER = hasGuess ? 'AND e.guess = 0' : '';

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
  // callers() matches a target by id, qname OR bare name, so the gap report
  // (gapsFor/gapsAround) has to resolve the same way. Going through store.node()
  // (id or qname only) meant a bare-name query silently dropped the whole
  // no-caller report — 184 rows on a real repo — while the rows above it kept
  // printing. Returns every matching node, so a name shared by several symbols
  // (e.g. two unrelated classes with the same method name) makes all of them
  // contribute their gap rows, not just whichever the caller finds first.
  const targetsFor = (nameOrId) => db.prepare(
    'SELECT * FROM nodes WHERE id = ? OR qname = ? OR name = ?').all(nameOrId, nameOrId, nameOrId);
  // Grouped by the reported node's id, not SELECT DISTINCT on every column:
  // two edges can reach the same caller/callee, one certain and one a guess,
  // and a plain DISTINCT would then print that node twice — once per guess
  // value — instead of once. MIN(e.guess) folds the group to 0 (certain) as
  // soon as any edge into that node is certain; only a node reached by
  // nothing but guesses reports guess = 1. A caller/callee that is certain by
  // ANY path should not be buried under the "uncertain" heading just because
  // some other, unrelated call site also guessed its way there.
  store.callers = (name) => db.prepare(`
    SELECT s.*, ${GUESS_COL} AS guess FROM edges e JOIN nodes s ON s.id = e.src_id
    JOIN nodes d ON d.id = e.dst_id WHERE d.name = ? OR d.qname = ? GROUP BY s.id`).all(name, name);
  store.callees = (name) => db.prepare(`
    SELECT d.*, ${GUESS_COL} AS guess FROM edges e JOIN nodes s ON s.id = e.src_id
    JOIN nodes d ON d.id = e.dst_id WHERE s.name = ? OR s.qname = ? GROUP BY d.id`).all(name, name);
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

  // Where an answer is incomplete. Queries walk resolved edges only, so without
  // this a dropped call site and "nothing calls this" print the same thing.
  // `reason`:
  //   'ambiguous' — an unresolved call whose bare name matches a repo symbol,
  //                 AND (when the call site wrote a qualifier, e.g. "fmt" in
  //                 "fmt.Errorf") that qualifier names a repo package — so a
  //                 real target may exist and be missing from the answer
  //   'external'  — an unresolved call with no repo candidate at all (stdlib,
  //                 third party, Go builtin), OR a qualified call whose
  //                 qualifier is not a repo package at all: "fmt.Errorf" can
  //                 never be a repo method called Errorf, no matter how many
  //                 repo methods share that bare name. Expected, counted, not
  //                 worth listing.
  //   'no-caller' — a RESOLVED call to the target made outside any indexed symbol
  //                 (module scope, a callback body), which `callers` cannot show
  // `reachable` is 0 only for a Go 'ambiguous' row in a file that neither belongs
  // to nor imports the target's package: a same-name coincidence is then far more
  // likely than a real call. Everything else is 1, including all non-Go rows.
  //
  // `qualifier_known`: a call site records the qualifier the source actually
  // wrote (dst_name up to the first dot). That qualifier can only ever name a
  // symbol in the package/type it points to, so if no node's qname starts with
  // "<qualifier>.", the call cannot reach a repo symbol — full stop, regardless
  // of how many repo symbols share the bare name. A bare dst_name (no dot) has
  // no qualifier to check, so it is always 1 (the old bare-name-only behavior).
  const QUALIFIER_KNOWN_SQL = (dstName, nodesAlias, lang) => `
    CASE WHEN instr(${dstName}, '.') = 0 THEN 1
         WHEN EXISTS (
           SELECT 1 FROM nodes ${nodesAlias} WHERE ${nodesAlias}.lang = ${lang}
             AND ${nodesAlias}.qname LIKE substr(${dstName}, 1, instr(${dstName}, '.') - 1) || '.%'
         ) THEN 1 ELSE 0 END`;
  // These are prepared lazily, inside the helpers that use them, like every
  // other statement in this function. gapRows names e.dst_bare/e.lang/
  // e.external, which do not exist before schema 6 — preparing it eagerly here
  // would throw as soon as attachReadHelpers runs, before any query is even
  // asked for, which breaks the read-only fallback on any pre-6 database (the
  // fallback exists precisely for a filesystem that can never be migrated).
  //
  // All are built with an `IN (...)` list sized to the batch instead of a
  // fixed `= ?`, so a caller can look up every name (or id) it needs in one
  // round trip instead of one round trip per name/id. SQLite bounds the
  // number of parameters a statement can bind, so a caller with a big batch
  // must split it — see `chunk` below.
  const gapRowsByNameSql = (n) => `
    SELECT e.dst_name, e.dst_bare, e.file, e.line, e.external, e.lang,
           s.qname AS src_qname
    FROM edges e LEFT JOIN nodes s ON s.id = e.src_id
    WHERE e.kind = 'call' AND e.dst_id IS NULL
      AND (e.dst_name IN (${Array(n).fill('?').join(',')})
        OR e.dst_bare IN (${Array(n).fill('?').join(',')}))`;
  // "How many repo symbols share this bare name" and "does this written
  // qualifier name a repo package" used to be correlated subqueries on
  // gapRowsByNameSql itself, so SQLite answered them once per MATCHED ROW.
  // For a common bare name that is thousands of repeats of the same handful
  // of questions — on prometheus/prometheus, 1,139 rows for "New" turned a
  // ~9ms base query into a 3.3s one. Both answers depend only on (bare name,
  // lang) or (qualifier, lang), never on the row itself, so collectGaps below
  // asks each question once per distinct pair instead: candidateCountsSql
  // batches every distinct bare name for one language into one grouped
  // count; qualifierExistsSql is asked once per distinct qualifier, and the
  // number of distinct qualifiers among matched rows is always small next to
  // the row count.
  const candidateCountsSql = (n) => `
    SELECT name, count(*) AS c FROM nodes
    WHERE lang = ? AND name IN (${Array(n).fill('?').join(',')})
      AND kind IN ('function','method','class')
    GROUP BY name`;
  const qualifierExistsSql = `SELECT 1 FROM nodes WHERE lang = ? AND qname LIKE ? LIMIT 1`;
  const noCallerRowsByIdSql = (n) => `
    SELECT e.dst_name, e.file, e.line FROM edges e
    WHERE e.kind = 'call' AND e.src_id IS NULL
      AND e.dst_id IN (${Array(n).fill('?').join(',')})`;
  // SQLite's bound-parameter cap (SQLITE_MAX_VARIABLE_NUMBER) can be as low as
  // 999. 400 leaves headroom even when a name list is bound twice — once for
  // dst_name IN (...), once for dst_bare IN (...) — 800 params at that cap.
  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
  const fileInPackageSql = `SELECT 1 FROM nodes WHERE file = ? AND qname LIKE ? LIMIT 1`;
  // Import paths are stored quoted: "x/internal/bufferpool" or "bufferpool".
  // SQL LIKE treats `_` as a one-character wildcard, so a package name that
  // contains an underscore can over-match a different import path that has some
  // other character in that spot. Accepted on purpose: `reachable` is a
  // relevance hint, not a resolution decision, so the worst case is a rare
  // false "yes", never a wrong link between symbols.
  const fileImportsPackageSql = `
    SELECT 1 FROM edges WHERE kind = 'import' AND file = ?
      AND (dst_name LIKE ? OR dst_name LIKE ?) LIMIT 1`;

  // The Go package a symbol lives in is the first segment of its qname.
  const goPackageOf = (node) =>
    node && node.lang === 'go' && node.qname.includes('.') ? node.qname.split('.')[0] : null;

  const reachableIn = (file, pkg) => {
    if (!pkg) return 1;
    if (db.prepare(fileInPackageSql).get(file, `${pkg}.%`)) return 1;
    if (db.prepare(fileImportsPackageSql).get(file, `%/${pkg}"`, `"${pkg}"`)) return 1;
    return 0;
  };

  // `symbols`: one entry per symbol whose name can legitimately appear as a
  // call target — {names, pkg}. gapsFor has exactly one (the target); gapsAround
  // adds one per node the impact walk reached. A gap row is scored against the
  // package of the symbol whose name variant actually matched it, not against
  // whichever symbol happens to be first in the list — the target and an
  // impact-reached node can live in different packages, and `callers` vs
  // `impact` must agree on the same row (see gapsAround).
  //
  // `callerCheckIds` are the node ids checked for a resolved-but-caller-less
  // call (the 'no-caller' reason). Both name-matched gaps and no-caller gaps
  // share one `seen` set, so a caller that wants no-caller rows for several
  // node ids at once (gapsAround, across a whole impact set) never needs a
  // second dedupe pass on top of this one.
  //
  // gapsAround can pass hundreds of symbols (one per impact-reached node).
  // Querying per symbol per name variant was the perf bug this batches away:
  // one name-matched symbol used to cost up to 3 round trips, so hundreds of
  // reached nodes meant hundreds of round trips to print a handful of rows.
  // Below, every name variant from every symbol is collected once into one
  // list and looked up in one (possibly chunked) query; the no-caller ids get
  // the same treatment. The row shape and the `seen`-based dedupe are exactly
  // as before — only the number of trips to SQLite changes.
  //
  // Candidate count per (bare name, lang), external rows excluded: an
  // external edge's candidate count is forced to 0 regardless of what nodes
  // exist (see the reason calc in collectGaps below), so there is nothing to
  // look up for it.
  const candidatesByLangBare = (rows) => {
    const byLang = new Map(); // lang -> Set(dst_bare)
    for (const r of rows) {
      if (r.external === 1 || r.lang == null || r.dst_bare == null) continue;
      (byLang.get(r.lang) ?? byLang.set(r.lang, new Set()).get(r.lang)).add(r.dst_bare);
    }
    const out = new Map(); // "lang|bare" -> count
    for (const [lang, bares] of byLang) {
      for (const names of chunk([...bares], 400)) {
        for (const row of db.prepare(candidateCountsSql(names.length)).all(lang, ...names)) {
          out.set(`${lang}|${row.name}`, row.c);
        }
      }
    }
    return out;
  };
  // Qualifier-exists answer per (qualifier, lang), for every dst_name that
  // actually has a qualifier written (a bare dst_name is always "known" — no
  // lookup needed, same as the old CASE's WHEN branch). External rows are
  // excluded for the same reason as above.
  const qualifiersByLangQualifier = (rows) => {
    const byLang = new Map(); // lang -> Set(qualifier)
    for (const r of rows) {
      if (r.external === 1 || r.lang == null) continue;
      const dot = r.dst_name.indexOf('.');
      if (dot === -1) continue;
      (byLang.get(r.lang) ?? byLang.set(r.lang, new Set()).get(r.lang)).add(r.dst_name.slice(0, dot));
    }
    const stmt = db.prepare(qualifierExistsSql);
    const out = new Map(); // "lang|qualifier" -> 0 | 1
    for (const [lang, quals] of byLang) {
      for (const q of quals) out.set(`${lang}|${q}`, stmt.get(lang, `${q}.%`) ? 1 : 0);
    }
    return out;
  };

  const collectGaps = (symbols, callerCheckIds = []) => {
    const seen = new Set(), out = [];

    // Record every symbol (by position) that offers each name variant — not
    // just the first, the way a single-owner map would. A bare name can now
    // come from several matched symbols (targetsFor in gapsFor/gapsAround),
    // and a row that matched more than one of them must not be scored against
    // just one: a possible real miss must not be demoted just because an
    // unrelated namesake in another package also matched the same name.
    const ownersByName = new Map(); // name -> [{ pkg, idx }, ...]
    const allNames = [];
    symbols.forEach(({ names, pkg }, idx) => {
      for (const name of new Set(names.filter(Boolean).map(String))) {
        if (!ownersByName.has(name)) { ownersByName.set(name, []); allNames.push(name); }
        ownersByName.get(name).push({ pkg, idx });
      }
    });
    // A row's dst_name and dst_bare can each carry their own owners; pool them
    // and score against that pkg only when every owner is the SAME symbol.
    // More than one distinct symbol involved means the row is ambiguous as to
    // which one actually matched — returning no pkg makes reachableIn() below
    // answer 1, which is exactly "keep it reachable".
    const pkgForRow = (r) => {
      const owners = [...(ownersByName.get(r.dst_name) ?? []), ...(ownersByName.get(r.dst_bare) ?? [])];
      const idxs = new Set(owners.map((o) => o.idx));
      return idxs.size === 1 ? owners[0].pkg : null;
    };

    // Pass 1: gather every matched row (still batched/chunked, unchanged).
    // Reason and reachable need the lookup maps built below, which need to
    // see every row's (bare, lang) and (qualifier, lang) pair first.
    const matched = [];
    for (const names of chunk(allNames, 400)) {
      const stmt = db.prepare(gapRowsByNameSql(names.length));
      matched.push(...stmt.all(...names, ...names));
    }
    const candidates = candidatesByLangBare(matched);
    const qualifierKnown = qualifiersByLangQualifier(matched);

    // Pass 2: classify each row from the two lookup maps instead of a
    // per-row correlated subquery.
    for (const r of matched) {
      const key = `${r.file}|${r.line}|${r.dst_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidateCount = r.external === 1 ? 0 : (candidates.get(`${r.lang}|${r.dst_bare}`) ?? 0);
      const dot = r.dst_name.indexOf('.');
      const known = dot === -1 ? 1 : (qualifierKnown.get(`${r.lang}|${r.dst_name.slice(0, dot)}`) ?? 0);
      const reason = candidateCount > 0 && known ? 'ambiguous' : 'external';
      out.push({
        file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
        reason,
        reachable: reason === 'ambiguous' && r.lang === 'go' ? reachableIn(r.file, pkgForRow(r)) : 1,
      });
    }
    if (callerCheckIds.length) {
      for (const ids of chunk([...new Set(callerCheckIds)], 400)) {
        const stmt = db.prepare(noCallerRowsByIdSql(ids.length));
        for (const r of stmt.all(...ids)) {
          const key = `${r.file}|${r.line}|${r.dst_name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ file: r.file, line: r.line, dst_name: r.dst_name,
            src_qname: null, reason: 'no-caller', reachable: 1 });
        }
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };

  // The name variants and package for one symbol, as collectGaps needs them.
  // A missing target (no node found) still has to run one gapRows pass under
  // the raw string the caller asked for — no package to score against.
  const symbolOf = (name, node) =>
    node ? { names: [String(name), node.name, node.qname], pkg: goPackageOf(node) }
         : { names: [String(name)], pkg: null };

  // A call site records whatever the source wrote, so match the target's bare
  // name as well as its qname — that is what finds a call made through an import
  // alias, a shadowed package name, or a receiver-qualified guess that missed.
  //
  // The target itself is resolved with targetsFor, not store.node: a bare name
  // (the natural thing to type after `search`) can match several symbols, and
  // every one of them may have its own no-caller call sites. Matching only by
  // id/qname (store.node) silently dropped the whole no-caller report for a
  // bare-name query — see the comment on targetsFor above.
  store.gapsFor = (name) => {
    const targets = targetsFor(name);
    if (!targets.length) return collectGaps([symbolOf(name, null)], []);
    return collectGaps(targets.map((t) => symbolOf(name, t)), targets.map((t) => t.id));
  };
  store.gapsFrom = (name) => {
    const n = store.node(name);
    if (!n) return [];
    return db.prepare(`
      SELECT e.dst_name, e.dst_bare, e.file, e.line, e.external, e.lang,
             (SELECT count(*) FROM nodes n2
              WHERE n2.name = e.dst_bare AND n2.lang = e.lang
                AND n2.kind IN ('function','method','class')) AS candidates,
             ${QUALIFIER_KNOWN_SQL('e.dst_name', 'n3', 'e.lang')} AS qualifier_known
      FROM edges e WHERE e.kind = 'call' AND e.dst_id IS NULL AND e.src_id = ?
      ORDER BY e.file, e.line`).all(n.id).map((r) => ({
        file: r.file, line: r.line, dst_name: r.dst_name, src_qname: n.qname,
        // Must agree with collectGaps' reason above: external when there is no
        // repo candidate at all, OR when a qualifier was written and it does
        // not name a repo package.
        reason: r.external === 1 || r.candidates === 0 || !r.qualifier_known ? 'external' : 'ambiguous',
        reachable: 1,
      }));
  };
  // The frontier of an impact walk: gaps naming the target AND gaps naming
  // anything the walk already reached, which is where it stopped.
  //
  // Resolved with targetsFor, same reasoning as gapsFor: a bare name can match
  // several symbols. impact() itself still walks from one id at a time (a
  // frontier is a per-symbol call graph, blending several would confuse the
  // walk), so run it once per matched target and merge the frontiers. A node
  // already counted as a target is dropped from the merged "reached" set so it
  // does not also show up as its own reached neighbour.
  store.gapsAround = (name) => {
    const targets = targetsFor(name);
    if (!targets.length) return collectGaps([symbolOf(name, null)], []);
    const targetIds = new Set(targets.map((t) => t.id));
    const reachedById = new Map();
    for (const t of targets) {
      for (const n of store.impact(t.qname)) {
        if (!targetIds.has(n.id)) reachedById.set(n.id, n);
      }
    }
    const reached = [...reachedById.values()];
    const symbols = [...targets.map((t) => symbolOf(name, t)), ...reached.map((n) => symbolOf(n.qname, n))];
    const callerCheckIds = [...targets.map((t) => t.id), ...reached.map((n) => n.id)];
    return collectGaps(symbols, callerCheckIds);
  };
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
        WHERE up.depth < ${MAX_DEPTH} AND e.src_id IS NOT NULL ${GUESS_FILTER}
      )
      SELECT DISTINCT n.* FROM nodes n JOIN up ON n.id = up.id WHERE n.id != ?`).all(target.id, target.id);
  };
  // How many guessed edges the walk above refused to follow, for this one
  // target. `impact` returning [] means one of two very different things:
  // nothing depends on this symbol, or the only paths in were guesses the
  // walk would not take. A caller cannot tell which from an empty array
  // alone, so count it: same walk, same set of certainly-reached nodes (the
  // target plus everything store.impact returns), and this counts every
  // guessed edge landing on one of them — the exact set of edges the filter
  // in store.impact turned away.
  store.impactSkippedGuesses = (name) => {
    if (!hasGuess) return 0; // no column, so nothing on this DB is a guess
    const target = store.node(name);
    if (!target) return 0;
    return db.prepare(`
      WITH RECURSIVE up(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e.src_id, up.depth + 1 FROM edges e
        JOIN up ON e.dst_id = up.id
        WHERE up.depth < ${MAX_DEPTH} AND e.src_id IS NOT NULL ${GUESS_FILTER}
      )
      SELECT count(*) AS c FROM edges e JOIN up ON up.id = e.dst_id WHERE e.guess = 1`).get(target.id).c;
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
