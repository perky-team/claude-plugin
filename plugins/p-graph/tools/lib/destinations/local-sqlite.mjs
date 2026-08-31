import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { OWNER_KINDS_SQL } from '../owner-kinds.mjs';
import { sigShape } from '../sig-shape.mjs';
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
// 8: field_types gained two row shapes for a receiver typed by a function's
// result — "<var key>" -> "#ret:<callee>" and "<callee qname>#ret" -> the declared
// result type. No DDL change, but the bump is not optional: an incremental reindex
// writes the "#ret:" marker for a file it reparses while the callee's "#ret" row
// still lives in a file it did not touch, and Pass B then refuses a call that a
// full index resolves certainly. So a graph written by 1.0.0 must be rebuilt whole
// rather than patched.
// 9: nodes gained `decl`, set on a node that comes from a DECLARATION rather than
// a definition — today only a C++ pure virtual. C++ allows a pure virtual to have a
// definition as well, and leveldb writes every convenience method on its interfaces
// that way (`virtual Status Put(…) = 0;` in db.h, `Status DB::Put(…) { … }` in
// db_impl.cc). Both nodes on one qname made the exact-qname pass refuse the pair, so
// `db_->Put(…)` stopped resolving and turned up in the gap report of an unrelated
// symbol. The resolver now drops a declaration whose definition exists, and it needs
// the column to know which is which.
// 10: TypeScript gained three kinds of node and three kinds of field_types row it
// never had — abstract classes and their methods, interface methods, and the type
// written on a class field (plus `#extends` and `#alias:` rows the resolver walks).
// No DDL change, but the bump is not optional: an incremental reindex would write
// the new rows for the files it reparses while a class in a file it did not touch
// still has none, and a call would then resolve differently from a full index —
// silently, and in the direction of false confidence.
// 11: Go interface methods are nodes. Same reason as 10 — new nodes appear, and a
// file the incremental pass did not reparse would still have none, so a call would
// resolve differently from a full index. This one also changes what an ANSWER says:
// a call written on an interface now lands on the interface's own method, and each
// concrete implementation reports those calls under the interface instead of as
// gaps. Reading the two side by side on a half-migrated graph would be worse than
// rebuilding it.
// 12: every method a Go interface declares is a node, not just the first one, and
// an interface method's `signature` is now its own source line instead of the
// interface's. Both change what an answer says: a call written on a multi-method
// interface used to land on nothing, and the method set used to decide "does this
// type implement that interface" was short — one name where the interface declares
// five, which made the interface-reach group over-report. An incremental reindex
// would hold the new rows for the files it reparsed and the old ones everywhere
// else, so the two would be read side by side. Rebuild whole.
// 13: same fix as 12, for TypeScript. An interface declaring `serialize`,
// `deserialize` and `reset` recorded one member, and the signature handed to it
// was `export interface Serializer {` — the interface's own declaration line, not
// the method's. New nodes appear and existing ones change their `signature`, so
// an incremental reindex would answer differently from a full rebuild depending on
// which files it happened to reparse. Rebuild whole.
//
// Same consequence as 12, running the other way. There, a short method set —
// one name where the interface declares five — made the interface-reach group
// over-report: almost any type looked like it implemented the interface. Here
// the method set grows, from one name to several, so a type now has to carry
// every one of them. A type the old, short method set called an
// implementation can now get refused.
// 14: a node extracted from a TypeScript declaration file (`.d.ts`, `.d.cts`,
// `.d.mts`) is marked `decl = 1`. Stored values change for every repo that ships
// one, so the graph is rebuilt rather than read as current.
export const SCHEMA_VERSION = 14;

// `ts` and `js` are one language for resolution. A repository that ships
// JavaScript, writes its tests in TypeScript and publishes an `index.d.ts` is not
// three repositories, and every type-reading pass in this file already says so with
// `lang IN ('ts','js')`. Measured on axios: the eight top-level
// `axios.interceptors.request.eject(...)` calls are `ts` rows and the method they
// call is a `js` node, so the bare-name fallback could never see it — while the
// identical calls in `.js` test files resolved.
//
// Nothing else joins. cpp and py stay apart, and that is deliberate: on re2, a C++
// library with a Python binding, matching across languages put seven Python calls to
// an unrelated `Match` into a C++ symbol's gap list. See gap-language.test.ts.
//
// This join is necessary but not sufficient for the axios recall gap: all eight of
// those call sites are top-level statements with `src_id = NULL`, and `store.callers`
// inner-joins on `src_id`, so they still cannot be printed however well the resolver
// does. The same shape hides 2,429 already-resolved edges across six study repos,
// 1,826 of them in hugo — which is Go, so this is not a TypeScript-only problem.
const langFamily = (lang) => (lang === 'ts' || lang === 'js' ? 'tsjs' : lang);
const SAME_LANG = (a, b) =>
  `((${a} = ${b}) OR (${a} IN ('ts','js') AND ${b} IN ('ts','js')))`;

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
  signature TEXT, doc TEXT, container_id TEXT, decl INTEGER DEFAULT 0
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
//  2. the node's own qname names the owner, and the node is C++. C++ defines a
//     method outside its class (`std::string PgStore::Get(int)` in the .cpp,
//     `class PgStore` in the .h), so it has no owner in its own file and rule 1
//     can never see one. The qname says `PgStore.Get` because the source wrote
//     `PgStore::`, and the owner is checked against a class this repo really
//     indexed — so for C++ this is a recorded fact.
//     It is limited to C++ because nothing here ties the matched node to the
//     target's REAL parent — only the text of the qname prefix. In every other
//     language the qname prefix IS the container, so rule 1 has already answered
//     and this clause can only add wrong owners: a function `render` nested
//     inside a FUNCTION named `Widget` has the qname `Widget.render`, and a CLASS
//     named `Widget` in another file would hand it an owner it does not have.
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
  OR (n.lang = 'cpp' AND EXISTS (SELECT 1 FROM nodes own WHERE own.lang = 'cpp'
            AND own.qname = substr(n.qname, 1, length(n.qname) - length(n.name) - 1)
            AND own.kind IN ${OWNER_KINDS_SQL}
            AND own.kind <> 'namespace')))`;
const MEMBER_TARGET_OK =
  `(edges.member = 0 OR edges.lang = 'go' OR ${memberOwnerSql('edges.lang')})`;

// Only these kinds can be the target of a call. A Go conversion (`Duration(v)`)
// parses as a call but names a type, and a call edge into a type node makes
// callers/impact report a caller that does not exist. `class` stays in:
// `new Service()` in TS and a C++ constructor call really do target one.
const CALLABLE = `('function','method','class')`;

// Languages where "the source types the receiver as some OTHER repo type" may be
// trusted as proof the call is not this target's, so the gap report can drop the
// row (see collectGaps). It is proof only when the graph could have seen a BASE
// class: a receiver typed as a subclass whose base declares the method is a real
// call site, and it looks exactly like an unrelated type when inheritance is not
// recorded.
//
//   ts, js  `extends` is captured (ts.scm) and walked in writtenReceiver.
//   go      embedding is captured and walked, the `#embed` hop.
//   py      inheritance is NOT recorded. Kept here anyway, and only because
//           there is no evidence to remove it: Python scores 243 of 243 call
//           sites in the study, so listing more rows there would add banners
//           that send the reader to grep for nothing. Revisit with a measured
//           Python case where a base-class call goes missing.
//
// cpp is absent, which is the point. Measured on rocksdb: two real call sites of
// `CompactionPicker::ExpandInputsToCleanCut` were dropped and the answer still
// printed `complete` — and the installed rule reads that as "stop. Do not grep."
const DROP_ON_OTHER_TYPE = new Set(['ts', 'js', 'go', 'py']);

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
  // Whether THIS open erased the graph. It has to travel with the store: until
  // something rebuilds the tables, every query answers zero rows — which reads
  // exactly like a true "nothing here" answer, so the caller has to be able to
  // tell the two apart. `graphErased` alone never means "cannot answer": a
  // rebuild in this same process refills the tables and clears schemaStale, so
  // both facts together are what mean the graph is still empty.
  const graphErased = Boolean(storedVersion && storedVersion < SCHEMA_VERSION);
  if (graphErased) {
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
    db, hasFts, graphErased,
    getMeta(key) { return getMetaStmt.get(key)?.value ?? null; },
    setMeta(key, value) { setMetaStmt.run(key, String(value)); },
    close() { db.close(); },
  };

  const insNode = db.prepare(`INSERT INTO nodes
    (id,name,qname,kind,lang,file,start_line,end_line,signature,doc,container_id,decl)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, qname=excluded.qname, kind=excluded.kind, lang=excluded.lang,
      file=excluded.file, start_line=excluded.start_line, end_line=excluded.end_line,
      signature=excluded.signature, doc=excluded.doc, container_id=excluded.container_id,
      decl=excluded.decl`);
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
          n.start_line, n.end_line, n.signature, n.doc, n.container_id, n.decl ? 1 : 0);
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

  // Pass T — a C++ receiver whose type the source writes down.
  //
  // A C++ declaration names the type the way the FILE can see it (`Batch`,
  // `db::Batch`), while the graph stores the qname built from lexical nesting
  // (`db.Batch`). The two are not the same string, so this cannot be one exact
  // lookup the way Pass F is for Go. Two hops instead: resolve the written name to
  // a class — and only when exactly one class in the repo carries it — then look
  // for that class's method.
  //
  // Both hops are guarded by "exactly one", so nothing here is a pick. Two classes
  // sharing a name means the source did not say which, and a guess dressed as a
  // fact is the one outcome worth more than a missing row.
  //
  // What it is for: a call written on a value is 40% of leveldb's call edges and
  // 43% of re2's, and before this pass not one of leveldb's 3,681 was certain.
  // Measured on the source, 46.5% of those receivers in leveldb and 41.6% in re2
  // name a repo class whose type is written in plain sight.
  //
  // Runs after Pass F (which answers the Go shape) and before Pass B, so a written
  // type always beats a bare-name guess. When the type IS recorded and leads
  // nowhere — `std::string`, an external class — this pass resolves nothing and
  // Pass B's existing guard refuses the fallback, which turns a wrong guess into
  // an honest gap.
  // Does this graph have `nodes.decl`? Detected like `edges.guess` and
  // `edges.dst_bare`: a graph written before schema 9 has no such column, and the
  // read-only fallback cannot migrate it. Without the column nothing is marked as a
  // declaration, so there is nothing to drop.
  const declColumn = () => {
    try { db.prepare('SELECT decl FROM nodes LIMIT 1').get(); return true; } catch { return false; }
  };

  const resolveCppReceiverTypes = () => {
    const pending = db.prepare(`
      SELECT rowid, file, src_id, field_key, method FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND lang = 'cpp' AND external = 0
        AND field_key IS NOT NULL AND method IS NOT NULL`).all();
    if (!pending.length) return;
    // The qname of the symbol each call is written inside, for the scope rule below.
    const srcQname = new Map();
    for (const n of db.prepare(
      `SELECT id, qname FROM nodes WHERE lang = 'cpp'`).all()) srcQname.set(n.id, n.qname);
    // One type per key. Two different types recorded for one key means the same
    // name was declared twice in one scope, and neither reading wins.
    const typeOf = new Map();
    for (const r of db.prepare('SELECT key, type FROM field_types').all()) {
      if (!typeOf.has(r.key)) typeOf.set(r.key, r.type);
      else if (typeOf.get(r.key) !== r.type) typeOf.set(r.key, null);
    }
    // Distinct QNAMES, not rows. C++ lets two .cc files each define their own class
    // of the same name — leveldb's three benchmark files all declare their own
    // `RandomGenerator` — and counting rows made a single class look like three, so
    // the check below refused a call that had only one possible answer.
    const classByName = new Map();
    for (const n of db.prepare(
      `SELECT name, qname FROM nodes WHERE lang = 'cpp' AND kind IN ('class','struct')`).all()) {
      if (!classByName.has(n.name)) classByName.set(n.name, new Set());
      classByName.get(n.name).add(n.qname);
    }
    const byQname = new Map();
    for (const n of db.prepare(
      `SELECT id, qname, file FROM nodes WHERE lang = 'cpp' AND kind IN ${CALLABLE}`).all()) {
      if (!byQname.has(n.qname)) byQname.set(n.qname, []);
      byQname.get(n.qname).push(n);
    }
    // C++ looks a bare type name up from the innermost scope outwards. Written
    // inside `namespace db`, `Iterator it;` means `db::Iterator` and never the
    // nested `db::SkipList::Iterator` — that one has to be spelled out. Refusing
    // whenever two classes share the short name threw both readings away; measured
    // on leveldb, 382 calls were left unresolved by that alone.
    const pickByScope = (cands, bare, caller) => {
      if (!caller) return null;
      let scope = caller;
      for (;;) {
        const cut = scope.lastIndexOf('.');
        scope = cut === -1 ? '' : scope.slice(0, cut);
        const want = scope ? `${scope}.${bare}` : bare;
        if (cands.includes(want)) return want;
        if (!scope) return null;
      }
    };
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    db.prepare('BEGIN').run();
    try {
      for (const e of pending) {
        const written = typeOf.get(e.field_key);
        if (!written) continue;
        // A smart pointer is a library type, but a call through it is not a library
        // call — `std::shared_ptr<Sink> s; s->Emit();` runs `Sink::Emit`. Read what
        // the pointer holds before anything else.
        const held = /(?:^|[.:])(?:shared_ptr|unique_ptr|weak_ptr|auto_ptr)\s*<\s*([\w.:]+)/
          .exec(written);
        const stripped = (held ? held[1].replaceAll('::', '.').replace(/[*&]+$/, '')
          : written).replace(/<.*/, '');
        let bare = stripped.split('.').pop();
        // The written name may be an alias rather than a class: `typedef Skip Table;`
        // then `Table table_;`. Follow one hop, and only one — a chain of aliases is
        // rare enough that stopping here costs nothing, and following any number of
        // them risks a cycle.
        //
        // A class-scoped alias is tried FIRST, before any class of that name: inside
        // MemTable, `Table` means MemTable's own typedef even though the repo also
        // has a `class Table`. The owning class is already in the field key.
        const owner = e.field_key.includes('#field:')
          ? e.field_key.split('#field:')[0].split('|').pop() : null;
        const scoped = owner ? typeOf.get(`${owner}#alias:${bare}`) : null;
        if (scoped) bare = scoped.split('.').pop();
        else if (!classByName.has(bare)) {
          const target = typeOf.get(`#alias:${bare}`);
          if (target) bare = target.split('.').pop();
        }
        let classes = [...(classByName.get(bare) ?? [])];
        if (!classes.length) continue;
        // The source may have written the owner out — `SkipList::Iterator it;`.
        // Keep only the classes whose qname ends with the path it wrote.
        if (stripped.includes('.') && bare === stripped.split('.').pop()) {
          const exact = classes.filter((c) => c === stripped || c.endsWith(`.${stripped}`));
          if (exact.length) classes = exact;
        }
        const holder = classes.length === 1 ? classes[0]
          : pickByScope(classes, bare, srcQname.get(e.src_id));
        if (!holder) continue;
        // The method may be declared on a BASE class, not on the type the source
        // wrote. `picker_->ExpandInputsToCleanCut(...)` in rocksdb types picker_ as
        // `UniversalCompactionPicker*` and the method is on its base
        // CompactionPicker; both call sites were missing before this walk and the
        // answer still printed `complete`.
        //
        // The subclass's OWN method wins, because the lookup only walks up when
        // the current class declares nothing of that name — which is what C++ does.
        // Each hop needs the base name to match exactly one class, so nothing here
        // is a pick. Eight hops is past any real hierarchy and stops a cycle dead.
        let hit = byQname.get(`${holder}.${e.method}`) ?? [];
        for (let cur = holder, hops = 0; !hit.length && hops < 8; hops++) {
          const base = typeOf.get(`${cur.split('.').pop()}#extends`);
          if (!base) break;
          const found = [...(classByName.get(base.split('.').pop()) ?? [])];
          if (found.length !== 1) break;
          cur = found[0];
          hit = byQname.get(`${cur}.${e.method}`) ?? [];
        }
        // One definition, or — when several files define their own copy under the
        // same qname — the one in the file the call is written in. That is what the
        // compiler sees, and it is the only choice that is not a coin toss. A call
        // in a THIRD file still gets nothing, which is the honest answer.
        const same = hit.filter((n) => n.file === e.file);
        const pick = hit.length === 1 ? hit[0] : (same.length === 1 ? same[0] : null);
        if (pick) setDst.run(pick.id, e.rowid);
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  };

  // Pass P — a TypeScript call written on a class FIELD, `this.svc.find(id)`.
  //
  // The same two-hop shape as Pass T, because TypeScript has the same problem C++
  // has: the declaration writes the type the way the file can see it (`Serializer`,
  // `ProducerSerializer`) while the graph stores a qname. Three extra hops that C++
  // does not need, each measured on nest and each needed by the SAME call:
  //
  //   `this.serializer.serialize(…)` in ClientKafka
  //     1. the receiver is a field         -> key on `<file>|<Class>#field:<name>`
  //     2. the field is on a BASE class    -> walk `<Class>#extends`
  //     3. its type is an alias            -> follow `#alias:ProducerSerializer`
  //     4. the alias names an INTERFACE    -> interfaces now own their methods
  //
  // Before this pass, none of the four existed and all 20 of those calls landed in
  // the gap banner of an unrelated method that shares the bare name `serialize`.
  //
  // Every hop is guarded by "exactly one", so nothing here is a pick. When a type
  // IS recorded and leads nowhere — a library class, `Redis` — the edge keeps the
  // key that typed it, and Pass B's existing guard then refuses the bare-name
  // fallback. An honest gap beats a wrong caller.
  const resolveTsFieldTypes = () => {
    const pending = db.prepare(`
      SELECT rowid, field_key, method, lang FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND lang IN ('ts','js') AND external = 0
        AND field_key LIKE '%#field:%' AND method IS NOT NULL`).all();
    if (!pending.length) return;
    // One type per key. Two different types under one key means two classes of one
    // name declared the same field differently, and neither reading wins.
    const typeOf = new Map();
    for (const r of db.prepare('SELECT key, type FROM field_types').all()) {
      if (!typeOf.has(r.key)) typeOf.set(r.key, r.type);
      else if (typeOf.get(r.key) !== r.type) typeOf.set(r.key, null);
    }
    const classByName = new Map();
    for (const n of db.prepare(
      `SELECT name, qname FROM nodes WHERE lang IN ('ts','js') AND kind IN ('class','interface')`).all()) {
      if (!classByName.has(n.name)) classByName.set(n.name, []);
      classByName.get(n.name).push(n.qname);
    }
    const byQname = new Map();
    for (const n of db.prepare(
      `SELECT id, qname FROM nodes WHERE lang IN ('ts','js') AND kind IN ${CALLABLE}`).all()) {
      if (!byQname.has(n.qname)) byQname.set(n.qname, []);
      byQname.get(n.qname).push(n.id);
    }
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    // The key that actually carried the type is written back onto the edge. That is
    // what lets Pass B refuse: its guard looks the edge's own field_key up in
    // field_types, and a field found on a base class lives under a key the call site
    // could not have known.
    const setKey = db.prepare('UPDATE edges SET field_key = ? WHERE rowid = ?');
    db.prepare('BEGIN').run();
    try {
      for (const e of pending) {
        const scoped = e.field_key.split('#field:');
        const fieldName = scoped[1];
        const cls = scoped[0].split('|').pop();
        // This file's own declaration first, then the class-wide one, then each
        // base class in turn. Eight steps is far past any real hierarchy and stops
        // a cycle dead.
        let matched = null;
        if (typeOf.get(e.field_key)) matched = e.field_key;
        else if (typeOf.get(`${cls}#field:${fieldName}`)) matched = `${cls}#field:${fieldName}`;
        else {
          let cur = cls;
          for (let i = 0; i < 8 && !matched; i++) {
            const base = typeOf.get(`${cur}#extends`);
            if (!base) break;
            if (typeOf.get(`${base}#field:${fieldName}`)) matched = `${base}#field:${fieldName}`;
            cur = base;
          }
        }
        if (!matched) continue;
        setKey.run(matched, e.rowid);
        let bare = typeOf.get(matched).split('.').pop();
        // One alias hop, and only one — the same rule Pass T follows.
        if (!classByName.has(bare)) {
          const target = typeOf.get(`#alias:${bare}`);
          if (target) bare = target.split('.').pop();
        }
        const owners = classByName.get(bare);
        if (owners?.length !== 1) continue;
        const hit = byQname.get(`${owners[0]}.${e.method}`);
        if (hit?.length === 1) setDst.run(hit[0], e.rowid);
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  };

  // Pass S — a TypeScript call written on a CLASS NAME, `NestFactory.create(app)`.
  //
  // The source named the owner itself, so there is nothing to infer: find the one
  // class of that name and look for its method. Guarded by "exactly one" twice, and
  // extraction has already checked that no variable of that name is in scope — a
  // `const Factory = …` shadowing the class makes the call a call on a value, and
  // then no key is written at all.
  //
  // When no repo class carries the name — an imported library class — this pass
  // resolves nothing and the bare-name fallback stays exactly as it was.
  //
  // `external = 1` rows are included on purpose, which is the one place this pass
  // differs from every other. Extraction marks `JSON.parse(…)` external from a word
  // list, and a repo that declares its own `class JSON` makes that mark wrong. Only
  // a whole-repo view can tell, and this is it — the same job Go's
  // resolveShadowedBuiltins does for `max(…)`. The mark itself is left as written,
  // for the reason given on that pass.
  const resolveTsStaticCalls = () => {
    const pending = db.prepare(`
      SELECT rowid, field_key, method FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND lang IN ('ts','js')
        AND field_key LIKE '#static:%' AND method IS NOT NULL`).all();
    if (!pending.length) return;
    const classByName = new Map();
    for (const n of db.prepare(
      `SELECT name, qname FROM nodes WHERE lang IN ('ts','js') AND kind IN ('class','interface')`).all()) {
      if (!classByName.has(n.name)) classByName.set(n.name, []);
      classByName.get(n.name).push(n.qname);
    }
    const byQname = new Map();
    for (const n of db.prepare(
      `SELECT id, qname FROM nodes WHERE lang IN ('ts','js') AND kind IN ${CALLABLE}`).all()) {
      if (!byQname.has(n.qname)) byQname.set(n.qname, []);
      byQname.get(n.qname).push(n.id);
    }
    // Values declared at the top of a module, keyed by name. This is what answers
    // `NestFactory.create(…)`: no class is called NestFactory — one file writes
    // `export const NestFactory = new NestFactoryStatic()` and every other file
    // calls methods on the name.
    const valueOf = new Map();
    for (const r of db.prepare(
      `SELECT key, type FROM field_types WHERE key LIKE '#value:%'`).all()) {
      const name = r.key.slice('#value:'.length);
      if (!valueOf.has(name)) valueOf.set(name, r.type);
      else if (valueOf.get(name) !== r.type) valueOf.set(name, null);
    }
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    db.prepare('BEGIN').run();
    try {
      for (const e of pending) {
        const written = e.field_key.slice('#static:'.length);
        // The name itself first — a class named outright beats a value that
        // happens to share the name.
        let owners = classByName.get(written);
        if (!owners) {
          const type = valueOf.get(written);
          if (type) owners = classByName.get(type.split('.').pop());
        }
        if (owners?.length !== 1) continue;
        const hit = byQname.get(`${owners[0]}.${e.method}`);
        if (hit?.length === 1) setDst.run(hit[0], e.rowid);
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  };

  // Pass N — C++ unqualified name lookup, outward.
  //
  // C++ looks an unqualified name up in the class first, then in each enclosing
  // namespace, then globally. Extraction records only the innermost reading:
  // `Scale(v)` written inside `Box::Grow` is stored as `geo.Box.Scale`. When no
  // node carries that name, the next scope out is where C++ itself would look,
  // so reading it is knowledge, not a guess — and these rows stay certain.
  //
  // Measured before this pass: 58% of leveldb's resolved C++ call edges and 49%
  // of re2's were guesses, against 11% for Go and 5% for Python. leveldb's
  // `TotalFileSize` had all six of its callers right and all six marked
  // UNVERIFIED, and the agent then read version_set.cc five times to check them.
  // The pass turns 624 leveldb edges and 279 re2 edges exact.
  //
  // Every guard is a case where walking out would invent an answer:
  //   - ANY node already carries the inner qname: C++ stops at the first scope
  //     that has the name, even when overloads leave it unable to say which one.
  //     Without this, `InternalKeyComparator::Compare` calling its own other
  //     overload answered with the free `Compare` — a wrong row marked certain,
  //     and `impact` follows a certain row.
  //   - `member = 1`: a call written on a value never does scope lookup, so
  //     `fd.Flush()` can never mean `util::Flush`.
  //   - two candidates in the scope we reach: refuse, and stop. A pick would be
  //     a guess, and carrying on to an outer namesake would be a worse one.
  const resolveCppOutward = () => {
    const pending = db.prepare(`
      SELECT rowid, dst_name FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND lang = 'cpp' AND external = 0
        AND member = 0 AND dst_name IS NOT NULL AND instr(dst_name, '.') > 0`).all();
    if (!pending.length) return;
    const byQname = new Map();
    for (const n of db.prepare(
      `SELECT id, qname FROM nodes WHERE lang = 'cpp' AND kind IN ${CALLABLE}`).all()) {
      if (!byQname.has(n.qname)) byQname.set(n.qname, []);
      byQname.get(n.qname).push(n.id);
    }
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    // One transaction for the pass, for the reason given on Pass L: an UPDATE of
    // its own costs a disk sync each, and this pass resolves hundreds of edges.
    db.prepare('BEGIN').run();
    try {
      for (const e of pending) {
        if (byQname.has(e.dst_name)) continue;
        const segs = e.dst_name.split('.');
        const name = segs[segs.length - 1];
        for (let k = segs.length - 2; k >= 0; k--) {
          const hit = byQname.get([...segs.slice(0, k), name].join('.'));
          if (!hit) continue;
          if (hit.length === 1) setDst.run(hit[0], e.rowid);
          break;
        }
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  };

  // Pass S — a Go declaration that shadows a builtin. Extraction marks a plain
  // call to `max`, `len`, `new` … external, because a call to a Go builtin
  // belongs to no package and must not be package-qualified. That mark is a
  // per-file guess: a package may declare `func max` itself (Go 1.21 added the
  // builtins min/max, so any repo supporting an older Go does), and Go's own
  // scoping rule then makes a plain `max(...)` inside that package mean the
  // declaration, not the builtin. Extraction reads one file at a time, so it
  // cannot know whether any file of the package declares the name — this pass
  // runs after every file is stored, which is the first point where the whole
  // repo is visible.
  //
  // The call site's package is the first segment of any Go qname in its file.
  // Two candidates (two build-tagged files declaring the same name) resolve to
  // neither: a pick would be a guess.
  //
  // `external` itself is left as extraction wrote it. The invalidation at the
  // top of resolvePending clears dst_id only, so a 0 stored here would outlive
  // the declaration that justified it, and the gap report would then call a
  // real builtin call "ambiguous" for as long as the graph lives.
  const resolveShadowedBuiltins = () => {
    const candidates = db.prepare(`
      SELECT rowid, file, dst_name FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND external = 1 AND lang = 'go'
        AND member = 0 AND dst_name IS NOT NULL`).all();
    if (!candidates.length) return;
    const pkgOfFile = db.prepare(`
      SELECT substr(qname, 1, instr(qname, '.') - 1) AS pkg FROM nodes
      WHERE file = ? AND lang = 'go' AND instr(qname, '.') > 0 LIMIT 1`);
    const byQname = db.prepare(
      `SELECT id FROM nodes WHERE qname = ? AND lang = 'go' AND kind IN ${CALLABLE} LIMIT 2`);
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    const pkgOf = new Map();
    for (const e of candidates) {
      if (!pkgOf.has(e.file)) pkgOf.set(e.file, pkgOfFile.get(e.file)?.pkg ?? null);
      const pkg = pkgOf.get(e.file);
      if (!pkg) continue; // a file with no indexed Go symbol names no package
      const hits = byQname.all(`${pkg}.${e.dst_name}`);
      if (hits.length !== 1) continue;
      setDst.run(hits[0].id, e.rowid);
    }
  };

  // Pass SP — the same idea for Python. Extraction marks a plain `set(xs)` or
  // `len(xs)` external, because those name the language. A repo may declare its
  // own `def set(...)`, and then a plain call to it means the declaration.
  //
  // A Python qname carries no module path, so "the same package" cannot be
  // asked here the way it is for Go. The guard is the whole repo instead:
  // exactly one node of that qname, or nothing is claimed. Two modules each
  // declaring `def set` is the Python twin of two build-tagged Go files, and a
  // pick between them would be a guess.
  //
  // As in Pass S, `external` itself is left as extraction wrote it — only
  // dst_id is set, so nothing outlives the declaration that justified it.
  const resolvePyShadowedBuiltins = () => {
    const candidates = db.prepare(`
      SELECT rowid, dst_name FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND external = 1 AND lang = 'py'
        AND member = 0 AND dst_name IS NOT NULL`).all();
    if (!candidates.length) return;
    const byQname = db.prepare(
      `SELECT id FROM nodes WHERE qname = ? AND lang = 'py' AND kind IN ${CALLABLE} LIMIT 2`);
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    const cache = new Map();
    for (const e of candidates) {
      if (!cache.has(e.dst_name)) {
        const hits = byQname.all(e.dst_name);
        cache.set(e.dst_name, hits.length === 1 ? hits[0].id : null);
      }
      const id = cache.get(e.dst_name);
      if (id) setDst.run(id, e.rowid);
    }
  };

  // Pass L — what the call site can see wins. A top-level function in JS,
  // TypeScript, Python or C++ has a BARE qname (`walk`, not `util.walk`), so the
  // exact-qname pass below treats a plain `walk(...)` written ANYWHERE in the repo
  // as an exact match for it, and calls the match certain. Measured on p-graph's
  // own source: `walk(true)` inside attachReadHelpers linked to build.mjs's walk
  // while the real target, a closure named walk, sat eleven lines above the call
  // in the same file. A false CERTAIN row is the worst kind — `impact` follows it.
  //
  // So resolve lexical scope FIRST: when the calling file holds a definition of
  // that name which the call site can actually see, that definition is the answer.
  // This pass only ever claims edges Pass A would otherwise claim by name alone,
  // so it cannot lose an edge; and reading scope is knowledge, not a guess, which
  // is why these rows stay certain.
  //
  // Deliberately narrow:
  //   - `lang <> 'go'`: a Go call target is already package-qualified, and a Go
  //     method call carries a bare method name that means something else entirely.
  //   - `member = 0`: `o.walk()` is a call on a value. A function in scope is not
  //     a candidate for it, whatever it is named.
  //   - a candidate owned by a class, struct, interface or namespace is skipped:
  //     a bare `walk()` inside a class is not a call on that class (only
  //     `this.walk()` is). A TypeScript namespace is lexical and would be safe,
  //     but it shares the owner list, so it falls through to Pass A as before.
  //   - two definitions of one name in one scope: refuse. A pick would be a guess.
  const resolveLexicalScope = () => {
    const pending = db.prepare(`
      SELECT rowid, file, line, dst_name, lang FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND member = 0 AND lang <> 'go' AND instr(dst_name, '.') = 0`).all();
    if (!pending.length) return;
    // Every candidate in one query, grouped by file+language+name. One query per
    // call site instead cost 3 s of a 43 s index on a 1,728-file repo, for a table
    // of 5,804 rows that fits in memory many times over.
    // The join reads the candidate's own container, because that is the scope the
    // definition lives in: code can see it only from inside that container.
    const byKey = new Map();
    for (const n of db.prepare(`
      SELECT n.id, n.file, n.name, n.lang, n.container_id,
             c.start_line AS c_start, c.end_line AS c_end
      FROM nodes n LEFT JOIN nodes c ON c.id = n.container_id
      WHERE n.kind IN ${CALLABLE} AND (c.id IS NULL OR c.kind NOT IN ${OWNER_KINDS_SQL})`).all()) {
      const key = `${n.file}|${n.lang}|${n.name}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(n);
    }
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    // One transaction for the whole pass. This resolves hundreds of edges on a
    // small repo, and an UPDATE of its own outside a transaction costs a disk
    // sync each — that alone was 900 ms of a 2.6 s full index. resolvePending
    // itself runs outside any transaction (every other writer opens its own), so
    // this is the outermost one and cannot nest.
    db.prepare('BEGIN').run();
    try {
      for (const e of pending) {
        const rows = byKey.get(`${e.file}|${e.lang}|${e.dst_name}`);
        if (!rows?.length) continue;
        // A top-level definition is visible in its whole file. A nested one is
        // visible only inside the scope that holds it — which is what makes the
        // call in a sibling function keep the answer it had before.
        const visible = rows.filter((r) => r.container_id === null
          || (r.c_start !== null && r.c_start <= e.line && e.line <= r.c_end));
        if (!visible.length) continue;
        // Innermost wins. Of two scopes that both hold the call site, one is inside
        // the other, so the one that STARTS LATER is the inner one.
        const depth = (r) => (r.container_id === null ? -1 : r.c_start);
        const deepest = Math.max(...visible.map(depth));
        const winners = visible.filter((r) => depth(r) === deepest);
        if (winners.length !== 1) continue;
        setDst.run(winners[0].id, e.rowid);
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  };

  // Pass R — a receiver typed by a function's RETURN VALUE. `b := hugolib.Test(t)`
  // then `b.AssertFileContent(...)`: nothing at the call site names a type, and the
  // bare-name fallback used to answer it — the largest single source of false rows
  // on a real repo. Two facts read from the source close it: extraction records the
  // callee under the variable's key ("#ret:hugolib.Test") and the callee's own
  // declared result type under "<qname>#ret". Following one to the other is
  // knowledge, not a guess, so these rows are certain.
  //
  // Guarded like Pass F: exactly one type recorded for the variable, exactly one
  // result type for that callee, and exactly one node with the target qname. When
  // the callee is outside the repo (`x := reflect.ValueOf(v)`) there is no result
  // row at all, so nothing resolves here — and Pass B then refuses to guess,
  // because a "#ret:" row means the type is decided somewhere we cannot read.
  const resolveReturnTypes = () => {
    const pending = db.prepare(`
      SELECT rowid, field_key, method, lang FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND lang IN ('go', 'py', 'ts', 'js')
        AND field_key IS NOT NULL AND method IS NOT NULL`).all();
    if (!pending.length) return;
    // One row per key, and only when that key has exactly one recorded type: two
    // types for one name is a conflict, and picking would be a guess.
    const typeOfKey = new Map();
    for (const r of db.prepare('SELECT key, type FROM field_types').all()) {
      typeOfKey.set(r.key, typeOfKey.has(r.key) && typeOfKey.get(r.key) !== r.type ? null : r.type);
    }
    const nodeByQname = db.prepare(
      `SELECT id FROM nodes WHERE qname = ? AND lang = ? AND kind IN ${CALLABLE} LIMIT 2`);
    // `jar = RequestsCookieJar()` in Python and `new Conn()` elsewhere: a
    // constructor call means the variable IS that class, so the callee itself is
    // the type. Only when exactly one class carries the name — two would be a pick.
    const classByQname = db.prepare(
      `SELECT qname FROM nodes WHERE qname = ? AND lang = ? AND kind = 'class' LIMIT 2`);
    const classCache = new Map();
    const typeFromClass = (callee, lang) => {
      const k = `${callee}|${lang}`;
      if (!classCache.has(k)) {
        const hits = classByQname.all(callee, lang);
        classCache.set(k, hits.length === 1 ? hits[0].qname : null);
      }
      return classCache.get(k);
    };
    const setDst = db.prepare('UPDATE edges SET dst_id = ?, guess = 0 WHERE rowid = ?');
    const idCache = new Map();
    db.prepare('BEGIN').run();
    try {
      // What a recorded row states. A plain row IS the type. A "#ret:" row is
      // one hop: the callee's declared result, or the class the callee names.
      //
      // Python needs one hop more, and only Python. `r = client.request()`
      // records "#ret:client.request", where the head is a VALUE in the same
      // scope, not a module — so the callee has no qname of its own until we
      // know what `client` is. Two facts, both written down: `client` is a
      // Client, and `Client.request` is declared `-> Response`. httpx's tests
      // open a client with `with httpx.Client() as client` and then write that
      // shape everywhere; the four call sites missing from
      // `callers "Response.raise_for_status"` are all of it.
      //
      // The depth guard stops at one extra hop. A chain that needs more is a
      // chain we would be inferring rather than reading.
      const typeOf = (row, scope, lang, depth) => {
        if (!row) return null;
        if (!row.startsWith('#')) return row;
        if (!row.startsWith('#ret:')) return null;
        const callee = row.slice('#ret:'.length);
        const direct = typeOfKey.get(`${callee}#ret`) ?? typeFromClass(callee, lang);
        if (direct) return direct;
        if (depth >= 1 || lang !== 'py' || !scope || !callee.includes('.')) return null;
        const dot = callee.indexOf('.');
        const head = typeOf(typeOfKey.get(`${scope}#var:${callee.slice(0, dot)}`), scope, lang, depth + 1);
        return head ? (typeOfKey.get(`${head}.${callee.slice(dot + 1)}#ret`) ?? null) : null;
      };
      for (const e of pending) {
        const marker = typeOfKey.get(e.field_key);
        if (!marker || !marker.startsWith('#ret:')) continue;
        const at = e.field_key.indexOf('#var:');
        const retType = typeOf(marker, at === -1 ? null : e.field_key.slice(0, at), e.lang, 0);
        if (!retType) continue; // callee outside the repo, or several result types
        const qname = `${retType}.${e.method}`;
        const key = `${qname}|${e.lang}`;
        if (!idCache.has(key)) {
          const hits = nodeByQname.all(qname, e.lang);
          idCache.set(key, hits.length === 1 ? hits[0].id : null);
        }
        const id = idCache.get(key);
        if (id) setDst.run(id, e.rowid);
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  };

  store.resolvePending = () => {
    // Invalidate every call edge and resolve from scratch. A resolved edge can
    // become ambiguous when a new same-named symbol appears, so keeping it would
    // make an incremental index answer differently from a full rebuild —
    // silently, and in the direction of false confidence.
    // guess is cleared with dst_id: a re-resolve must not let a stale 1 from a
    // previous index survive on an edge that this pass now resolves for real.
    db.prepare(`UPDATE edges SET dst_id = NULL, guess = 0 WHERE kind = 'call'`).run();

    // A declaration whose definition exists is redundant, and worse than
    // redundant: two nodes on one qname make the exact-qname pass refuse both, so
    // a call that named the symbol exactly stops resolving and turns up in the gap
    // report of whatever else shares the bare name. C++ allows a pure virtual to
    // have a definition, and leveldb writes every convenience method on its
    // interfaces that way. Measured: `virtual Status Put(…) = 0;` in db.h plus
    // `Status DB::Put(…)` in db_impl.cc put two rows into an otherwise complete
    // `callers "WriteBatch::Put"` answer, and the ⚠ banner they raised sent the
    // agent grepping — the question then cost what it cost with no graph at all.
    //
    // Runs at the head of resolve, before dst_id is cleared, so nothing is left
    // pointing at a node that is about to go. Idempotent: a later incremental
    // reindex re-adds the declaration and the next resolve drops it again.
    if (declColumn()) {
      db.prepare(`DELETE FROM nodes WHERE decl = 1 AND EXISTS (
        SELECT 1 FROM nodes o WHERE o.qname = nodes.qname AND o.lang = nodes.lang
          AND o.decl = 0)`).run();
    }

    // Runs before Pass A on purpose: a definition the call site can see is a
    // better answer than a same-named symbol in a file it may never have heard of.
    resolveLexicalScope();

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

    // Runs next to Pass A because it settles the same kind of question — an
    // exact qualified name — and it only ever touches edges Pass A cannot: the
    // ones extraction marked external.
    resolveShadowedBuiltins();
    resolvePyShadowedBuiltins();

    // Runs after Pass A and before every fallback: the innermost scope is the
    // better answer whenever it has one, and a scope C++ really would search is
    // a better answer than a bare name that merely matches.
    resolveCppOutward();

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

    // Runs after Pass F (a type written at the declaration is better evidence than
    // one read from a callee's signature) and before the bare-name fallback.
    resolveReturnTypes();

    // The C++ shape of the same question, for the reason on the pass itself: a
    // written C++ type is not the same string as the qname, so it needs two hops
    // where Go needs one. Before Pass B, so a written type beats a bare name.
    resolveCppReceiverTypes();

    // TypeScript's shape of the same question. Also before Pass B, and after Pass F
    // for the same reason: a type written on the declaration beats a bare name.
    resolveTsFieldTypes();
    resolveTsStaticCalls();

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
    // and an interface embeds nothing, so it could not supply a legitimate target
    // either. Linking the bare name to the one repo method that shares it produced
    // 13 false callers for a single symbol in hugo.
    //
    // An interface DOES own its methods now (schema 10 for TypeScript, 11 for Go),
    // so a call through one is answered exactly by Pass F or Pass P, before this
    // pass runs. What is left here is the case that never had an answer: the type is
    // recorded and it leads nowhere.
    // A bare name is not a fact about the receiver's type — it is a guess that
    // the one repo symbol with this name is the one the call site meant.

    // A declaration is not a rival definition. Joining ts and js below would
    // otherwise LOSE call sites that resolve today: axios publishes `index.d.ts`
    // and `index.d.cts`, both declaring `AxiosInterceptorManager.eject`, so the
    // bare name `eject` would have three callable nodes where it has one, and the
    // "exactly one" guard would refuse them all. 18 names in axios are ambiguous for
    // this reason and no other. So when a name has a real definition, declarations
    // of that name stop counting here. A graph written before schema 9 has no
    // `decl` column and nothing is marked, so the guard is left out entirely there.
    //
    // The declared node itself survives only when its qname DIFFERS from the
    // definition's. That is the common case for a published `.d.ts`, because it
    // renames the API — axios declares `AxiosInterceptorManager.eject` for
    // `InterceptorManager.eject`. When the two qnames match, the DELETE at the head
    // of resolve removes the declared node instead: it is keyed on qname + lang, and
    // every node in a `.d.ts` file is lang `ts`. Measured — `index.d.ts` declaring
    // `interface Api { send(...) }` beside `src/api.ts` defining
    // `class Api { send() {} }` loses both of the `.d.ts` nodes.
    //
    // One effect of that is new here, and it is NOT fixed. In C++, `decl = 1` never
    // lands on a class node, so a C++ parent always survives. A `.d.ts` marks every
    // node in the file, container included. So when the declaration file states a
    // member the class does not define, the container is deleted and the member is
    // left with a container_id pointing at nothing. Nothing crashes — `ownerOf` and
    // `implementationReach` both guard — but `memberOwnerSql` needs that container
    // row, so a declared-only method quietly stops being reachable as a member call.
    // Pinned in ts-js-one-family.test.ts. Changing the DELETE needs its own
    // measurement.
    //
    // Last, this closes the lying banner for ONE call shape. Pass C
    // (`resolveOwnReceiverFallback`, the `this.m()` / `self.m()` fallback) still
    // matches per exact lang and has no definitionWins guard. Measured in the same
    // repo, on the same name: `index.d.ts` declaring `interface BaseLike { eject }`
    // (a renamed API, the way axios writes one), `lib/Base.js` defining
    // `class Base { eject }`, and `src/Child.ts` calling `this.eject(1)`. Pass C
    // sees one `ts` node called `eject` — the declaration — and links the call to
    // it, so `callers Base.eject` prints "complete — no gaps" and never names
    // src/Child.ts:3. Pre-existing: byte-identical output on cad73e2. Widening this
    // pass would add new resolved rows, so it waits for its own measurement.
    //
    // Only for ts and js. `decl = 1` is not only a `.d.ts` marker: driver.mjs also
    // sets it on a bodyless C++ in-class declaration, e.g. a pure virtual method.
    // Without the language check here, a C++ pure virtual with exactly one in-repo
    // implementation would stop counting as a rival too, and a call that used to be
    // an honest gap (two candidates, refuse) would silently turn into a guess. The
    // study's published C++ numbers were measured before this change, so C++ (and
    // Python) must keep the old behaviour. See cpp-decl-vs-def.test.ts.
    const definitionWins = declColumn()
      ? `AND (n.decl = 0 OR n.lang NOT IN ('ts','js') OR NOT EXISTS (
           SELECT 1 FROM nodes d
           WHERE d.name = n.name AND d.kind IN ${CALLABLE} AND d.decl = 0
             AND ${SAME_LANG('d.lang', 'n.lang')}))`
      : '';
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.name = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}
          AND n.kind IN ${CALLABLE} AND ${MEMBER_TARGET_OK} ${definitionWins}
        LIMIT 1
      ), guess = 1
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}) = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.name = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}
               AND n.kind IN ${CALLABLE} ${definitionWins}) = 1
        AND EXISTS (SELECT 1 FROM nodes n
             WHERE n.name = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}
               AND n.kind IN ${CALLABLE} AND ${MEMBER_TARGET_OK} ${definitionWins})
        AND NOT EXISTS (
          SELECT 1 FROM field_types ft
          WHERE ft.key = edges.field_key
            -- A "#ret:" marker says the type is decided by a callee. For Go and
            -- Python that is evidence: the callee is knowable, so failing to
            -- resolve it means the value is not this repo's, and refusing the
            -- guess was measured as the largest single cut in false rows.
            -- TypeScript is the other way round and was measured that way too:
            -- "const module = await Test.createTestingModule(...).compile()" is
            -- everywhere in nest, nothing can read what it returns, and refusing
            -- there threw away 190 rows that were all correct. So for TS and JS
            -- a marker means "unknown", not "known and not this", and Pass R
            -- above has already had its chance at it.
            --
            -- "Unknown" is the exact word: the marker is skipped only when
            -- nothing at all could be learned about the callee. When the callee
            -- DOES declare a result and it simply is not a repo class — a
            -- function returning a node:stream Duplex — that is evidence, and
            -- the refusal stands.
            AND NOT (edges.lang IN ('ts','js') AND ft.type LIKE '#ret:%'
              AND NOT EXISTS (SELECT 1 FROM field_types r
                              WHERE r.key = substr(ft.type, 6) || '#ret')
              AND NOT EXISTS (SELECT 1 FROM nodes cn
                              WHERE cn.qname = substr(ft.type, 6) AND cn.kind = 'class'))
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

  // Every gap statement names edges.dst_bare, added in schema 6. A writable open
  // rebuilds such a database, so the only way to be reading one is the read-only
  // fallback — a filesystem that can never be migrated, which is exactly what the
  // fallback exists for. Detected once, like the guess column: the rows a query
  // CAN answer are answered, and the gap report reports itself missing instead of
  // taking four commands down with "no such column: e.dst_bare".
  //
  // An empty gap list is not the same claim as "no gaps", so this is a flag the
  // caller must relay, not a silent []. The CLI prints it and puts it in --json.
  let hasBare = true;
  try { db.prepare('SELECT dst_bare FROM edges LIMIT 1').get(); } catch { hasBare = false; }
  store.gapsUnavailable = !hasBare;

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
  // Every name in the graph that one query can mean.
  //
  // C++ writes a scope with `::`, and the graph stores it with a dot and the
  // namespace in front — `WriteBatchInternal::Count` is `leveldb.WriteBatchInternal.Count`.
  // Measured on leveldb and re2: the `::` spelling matched nothing, and so did
  // `WriteBatchInternal.Count`. Only the bare name and the full dotted qname
  // worked, and neither is how a C++ reader writes the symbol. The cost showed
  // up in the A/B — the agent spent three to five tool calls per question
  // hunting for a spelling that answered, against grep's one.
  //
  // Two readings, in this order:
  //   1. LITERALLY — an id, a qname, or a bare name. This is what every other
  //      language relies on and it must never lose to the reading below.
  //   2. as the TAIL of a qname, but only for a query that wrote a separator.
  //      `Box::Size` and `Box.Size` can mean `deep.Box.Size`; a plain `Size`
  //      may not, or asking for one symbol would quietly merge every namesake
  //      nested anywhere. When the tail fits several symbols they are ALL
  //      returned, so the CLI names them instead of picking one in silence.
  const literalName = db.prepare('SELECT 1 FROM nodes WHERE id = ? OR qname = ? OR name = ? LIMIT 1');
  // `_` and `%` are LIKE wildcards, and a C++ name is full of underscores
  // (`rep_`, `mem_table_`). Without escaping, `Store::rep_` would also match
  // `Store.repX`.
  const likeTail = db.prepare("SELECT DISTINCT qname FROM nodes WHERE qname LIKE ? ESCAPE '\\'");
  const matchNames = (raw) => {
    const s = String(raw);
    if (literalName.get(s, s, s)) return [s];
    const dotted = s.replace(/::/g, '.');
    if (dotted !== s && literalName.get(dotted, dotted, dotted)) return [dotted];
    if (!dotted.includes('.')) return [s];
    const tails = likeTail.all(`%.${dotted.replace(/[\\%_]/g, (c) => `\\${c}`)}`).map((r) => r.qname);
    return tails.length ? tails : [s];
  };
  const holes = (n) => Array(n).fill('?').join(',');

  store.node = (idOrQname) => {
    const ns = matchNames(idOrQname);
    return db.prepare(`SELECT * FROM nodes WHERE id IN (${holes(ns.length)})
                       OR qname IN (${holes(ns.length)}) LIMIT 1`).get(...ns, ...ns) ?? null;
  };
  // The three spellings of one target, as a single SQL condition: an id, a bare
  // name, or a qname. Every command must find a target the same way, or two
  // commands answer different questions from the same words. Bind the name list
  // three times, once per term.
  //
  // Two failures came from a query that used a smaller set:
  //   - `store.node` (id or qname only) resolved the target of `impact` and
  //     `callees`, so `impact Root` answered about NOTHING for every Go function
  //     and every method in any language — and then said `✓ complete`. The rule
  //     this plugin ships tells the agent to ask by bare name.
  //   - `store.callers` and `store.callees` matched a name or a qname only, so an
  //     ID argument printed an empty list: `context <node-id>` showed no callers
  //     at all, with the same `✓ complete` under it.
  // A node id is 16 hex characters, so it can never collide with a real name.
  const namesTarget = (alias, n) => `${alias}.id IN (${holes(n)})
      OR ${alias}.name IN (${holes(n)}) OR ${alias}.qname IN (${holes(n)})`;
  // Every node one query can mean. Returns ALL of them, so a name shared by
  // several symbols (e.g. two unrelated classes with the same method name) has
  // every one of them contribute its rows, not just whichever the caller finds
  // first.
  const targetsFor = (nameOrId) => {
    const ns = matchNames(nameOrId);
    return db.prepare(`SELECT n.* FROM nodes n
      WHERE ${namesTarget('n', ns.length)}`).all(...ns, ...ns, ...ns);
  };
  // Grouped by the reported node's id, not SELECT DISTINCT on every column:
  // two edges can reach the same caller/callee, one certain and one a guess,
  // and a plain DISTINCT would then print that node twice — once per guess
  // value — instead of once. MIN(e.guess) folds the group to 0 (certain) as
  // soon as any edge into that node is certain; only a node reached by
  // nothing but guesses reports guess = 1. A caller/callee that is certain by
  // ANY path should not be buried under the "uncertain" heading just because
  // some other, unrelated call site also guessed its way there.
  // Where the CALL is written, not where the caller is declared. Both were in
  // this table all along; only the declaration was ever printed, so every reader
  // had to go and find the call sites with a text search. group_concat has no
  // defined order, so the pairs are sorted here.
  const withSites = (rows) => rows.map(({ sites, ...n }) => ({
    ...n,
    call_sites: String(sites ?? '').split(',').filter(Boolean)
      .map((s) => { const i = s.lastIndexOf(':'); return { file: s.slice(0, i), line: Number(s.slice(i + 1)) }; })
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
  }));
  const SITES = `group_concat(DISTINCT e.file || ':' || e.line) AS sites`;

  // A call written outside any function — a module's top level, a Go package-level
  // `var x = pkg.New()`, a `@Injectable()` on a class — has no enclosing symbol, so
  // its edge holds `src_id = NULL` and the join in `store.callers` below cannot see
  // it. Those calls were reported in the gap banner instead, one line each, and
  // that banner stops at GAP_LIMIT rows. Measured on hugo: `parse.mkItem` has 120
  // of them, 20 were named and 100 were replaced by "… and 100 more". Across
  // axios, nest, got and hugo, 13 symbols are over the cap and 1,500 rows are
  // never named anywhere.
  //
  // The row this builds is shaped like a node row so every existing reader renders
  // it unchanged, but no node is stored for it. A node spanning the file would
  // enclose every top-level definition in it, and driver.mjs:1402 builds a child's
  // qname from its parent's — so every top-level qname in the file would gain a
  // file prefix. Pass A calls a unique bare qname CERTAIN, and the driver's own
  // comment at :1390 records three false certain rows from moving one qname.
  //
  // JOIN, not LEFT JOIN, on nodes d: only a RESOLVED edge (one whose dst_id
  // already names a real node) can contribute a row. An unresolved call at file
  // scope is not a call site of this symbol, and it stays in the gap report where
  // it belongs.
  //
  // One shape, two questions. `store.callers` asks by the target's NAME.
  // `store.impact` asks by the SET of nodes its reverse walk reached, which it
  // hands over as a CTE to prepend. Both need the same grouping, the same guess
  // column and the same site list, so they share the shape instead of drifting
  // apart — one query that reports a file-scope call, not two.
  const fileScopeSql = (where, cte = '') => `${cte}
    SELECT e.file, ${GUESS_COL} AS guess, ${SITES}
    FROM edges e JOIN nodes d ON d.id = e.dst_id
    WHERE e.kind = 'call' AND e.src_id IS NULL AND (${where})
    GROUP BY e.file ORDER BY e.file`;
  const fileScopeCallers = (ns) => db.prepare(fileScopeSql(
    namesTarget('d', ns.length))).all(...ns, ...ns, ...ns);
  // `sites` passes straight through so withSites — the one place that parses a
  // site list — is the one that turns it into call_sites, the same as it does for
  // an ordinary node row.
  const asFileRow = (r) => ({
    id: `filescope:${r.file}`,
    name: r.file.slice(r.file.lastIndexOf('/') + 1),
    qname: r.file, kind: 'file', lang: null, file: r.file,
    start_line: null, end_line: null, signature: null, doc: '',
    container_id: null, decl: 0, guess: r.guess, sites: r.sites,
  });
  store.callers = (name) => {
    const ns = matchNames(name);
    const nodeRows = withSites(db.prepare(`
      SELECT s.*, ${GUESS_COL} AS guess, ${SITES} FROM edges e JOIN nodes s ON s.id = e.src_id
      JOIN nodes d ON d.id = e.dst_id
      WHERE ${namesTarget('d', ns.length)}
      GROUP BY s.id`).all(...ns, ...ns, ...ns));
    // Node rows first, file rows last: a reader scans the top of a list.
    return [...nodeRows, ...withSites(fileScopeCallers(ns).map(asFileRow))];
  };
  store.callees = (name) => {
    const ns = matchNames(name);
    return withSites(db.prepare(`
      SELECT d.*, ${GUESS_COL} AS guess, ${SITES} FROM edges e JOIN nodes s ON s.id = e.src_id
      JOIN nodes d ON d.id = e.dst_id
      WHERE ${namesTarget('s', ns.length)}
      GROUP BY d.id`).all(...ns, ...ns, ...ns));
  };
  // Which symbol(s) a bare name actually reaches. `callers Get` merges every
  // symbol named Get and used to do it silently, so a reader had to run `search`
  // first to find out what they were asking about. One call now says so.
  // Matches an id too, so the "no symbol named X" line cannot fire for an id the
  // list rows above it just answered for.
  store.symbolsNamed = (name) => {
    const ns = matchNames(name);
    return db.prepare(`SELECT n.* FROM nodes n WHERE ${namesTarget('n', ns.length)}
      ORDER BY n.qname`).all(...ns, ...ns, ...ns);
  };
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
  //
  // There was a third reason, 'no-caller': a RESOLVED call to the target made
  // outside any indexed symbol (module scope, a `var x = pkg.New()`). It is gone,
  // code and all. `store.callers` and `store.impact` return a `kind: 'file'` row
  // for each such file, so those call sites are IN the answer, and naming them
  // again under ⚠ made one answer contradict itself — 2 sites listed, "2 sites
  // missing".
  //
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
           SELECT 1 FROM nodes ${nodesAlias} WHERE ${SAME_LANG(`${nodesAlias}.lang`, lang)}
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
    SELECT e.dst_name, e.dst_bare, e.file, e.line, e.external, e.lang, e.field_key,
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
  //
  // Both ask by language FAMILY, not by exact lang, and both bind that family's
  // language twice — once per side of SAME_LANG. Same rule as the resolver and as
  // the language filter below: a `.ts` call and the `.js` method it names are one
  // language. Keying these two per exact lang quietly undid the filter's fix.
  // Measured on the fixture in gap-language.test.ts: the `.ts` row survived the
  // filter, then counted 0 candidates because both `eject` nodes are `js`, so its
  // reason came out `external` — and an `external` row is counted, never listed.
  // The printed answer said "1 call the graph found nothing to link to" while the
  // graph held two nodes it could have linked to. See cli-unresolved.test.ts.
  const candidateCountsSql = (n) => `
    SELECT name, count(*) AS c FROM nodes
    WHERE ${SAME_LANG('lang', '?')} AND name IN (${Array(n).fill('?').join(',')})
      AND kind IN ('function','method','class')
    GROUP BY name`;
  const qualifierExistsSql = `SELECT 1 FROM nodes WHERE ${SAME_LANG('lang', '?')} AND qname LIKE ? LIMIT 1`;
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
  //
  // A third pattern covers a module imported at its own ROOT, where the path
  // ends in a major-version segment instead of the package name — caddy's own
  // module is "github.com/caddyserver/caddy/v2". goContext (driver.mjs) strips
  // that trailing "/vN" before naming a package for CALL resolution; this is
  // the same fix for the gap report's reachability check, which reads the raw
  // import edge text instead.
  //
  // A plain LIKE pattern for this ("%/<pkg>/v%\"") is too loose: "v%" has no
  // digit class, so it also matches a real, unrelated SIBLING subpackage whose
  // name starts with "v" — "github.com/x/logs/verify" wrongly reads as
  // reaching package "logs". GLOB does support a character class ([0-9]),
  // mirroring the driver's own `/^v[0-9]+$/` check for the same job, so this
  // one pattern uses GLOB instead of LIKE. GLOB's wildcards are `*`/`?`, not
  // LIKE's `%`/`_`, and it is case-sensitive with no ESCAPE clause — both fine
  // here because pkg is always a parsed Go identifier (letters/digits/`_`),
  // never something with a GLOB-special character in it to escape.
  const fileImportsPackageSql = `
    SELECT 1 FROM edges WHERE kind = 'import' AND file = ?
      AND (dst_name LIKE ? OR dst_name LIKE ? OR dst_name GLOB ?) LIMIT 1`;

  // The Go package a symbol lives in is the first segment of its qname.
  const goPackageOf = (node) =>
    node && node.lang === 'go' && node.qname.includes('.') ? node.qname.split('.')[0] : null;

  const reachableIn = (file, pkg) => {
    if (!pkg) return 1;
    if (db.prepare(fileInPackageSql).get(file, `${pkg}.%`)) return 1;
    if (db.prepare(fileImportsPackageSql).get(file, `%/${pkg}"`, `"${pkg}"`, `*/${pkg}/v[0-9]*"`)) return 1;
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
  // gapsAround can pass hundreds of symbols (one per impact-reached node).
  // Querying per symbol per name variant was the perf bug this batches away:
  // one name-matched symbol used to cost up to 3 round trips, so hundreds of
  // reached nodes meant hundreds of round trips to print a handful of rows.
  // Below, every name variant from every symbol is collected once into one
  // list and looked up in one (possibly chunked) query. The row shape and the
  // `seen`-based dedupe are exactly as before — only the number of trips to
  // SQLite changes.
  //
  // Candidate count per (bare name, lang), external rows excluded: an
  // external edge's candidate count is forced to 0 regardless of what nodes
  // exist (see the reason calc in collectGaps below), so there is nothing to
  // look up for it.
  const candidatesByLangBare = (rows) => {
    // family -> { lang, bares }. `lang` is one row's own language out of that
    // family, kept only to bind: SAME_LANG answers the same for `ts` as for
    // `js`, so which of the two it is cannot change a count.
    const byFamily = new Map();
    for (const r of rows) {
      if (r.external === 1 || r.lang == null || r.dst_bare == null) continue;
      const fam = langFamily(r.lang);
      if (!byFamily.has(fam)) byFamily.set(fam, { lang: r.lang, bares: new Set() });
      byFamily.get(fam).bares.add(r.dst_bare);
    }
    const out = new Map(); // "family|bare" -> count
    for (const [fam, { lang, bares }] of byFamily) {
      for (const names of chunk([...bares], 400)) {
        for (const row of db.prepare(candidateCountsSql(names.length)).all(lang, lang, ...names)) {
          out.set(`${fam}|${row.name}`, row.c);
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
    const byFamily = new Map(); // family -> { lang, quals }
    for (const r of rows) {
      if (r.external === 1 || r.lang == null) continue;
      const dot = r.dst_name.indexOf('.');
      if (dot === -1) continue;
      const fam = langFamily(r.lang);
      if (!byFamily.has(fam)) byFamily.set(fam, { lang: r.lang, quals: new Set() });
      byFamily.get(fam).quals.add(r.dst_name.slice(0, dot));
    }
    const stmt = db.prepare(qualifierExistsSql);
    const out = new Map(); // "family|qualifier" -> 0 | 1
    for (const [fam, { lang, quals }] of byFamily) {
      for (const q of quals) out.set(`${fam}|${q}`, stmt.get(lang, lang, `${q}.%`) ? 1 : 0);
    }
    return out;
  };

  // The type the source wrote for the receiver of an unresolved call, as the set of
  // names it could be matched against, or null when the source wrote nothing this
  // reader can use. Three key shapes:
  //   `#static:Widget`                 -> the call names the class outright.
  //   `<file>|<Class>#field:<name>`    -> the type written on that field, followed
  //                                       one alias hop, the same as Pass P does.
  //   `<scope>#var:<name>@<pos>`       -> the type written on a local or parameter.
  //                                       `let catsController: CatsController;` and
  //                                       `func Do(x *foo.X)` both say so outright.
  //
  // The set holds the name as written AND its last segment, because Go writes a
  // package-qualified type (`foo.X`) while TypeScript writes a bare one. A type that
  // EMBEDS another is matched too: a promoted method really is a target for a call
  // on the outer type, so such a row must not be ruled out.
  //
  // `#param` and `#ret:` are markers, not type names — they say the type is decided
  // somewhere this reader cannot see, which is the opposite of knowing it.
  //
  // Returns `{ names, repo }`, or null when the source wrote nothing usable.
  // `repo` says whether any of those names is a type THIS REPO declares. A call on a
  // library type is refused by the resolver and REPORTED — that is a tested,
  // published promise (see "refuses a call on a parameter whose type lives outside
  // the repo") — so such a row is never dropped here. It is only labelled, so the
  // report can count it in one line instead of listing it among rows the reader is
  // told to go and grep for. See the `library` reason in collectGaps.
  let receiverTypeCache = null;
  const writtenReceiver = (fieldKey) => {
    if (!fieldKey) return null;
    if (!receiverTypeCache) {
      receiverTypeCache = { type: new Map(), known: new Set() };
      for (const r of db.prepare('SELECT key, type FROM field_types').all()) {
        const m = receiverTypeCache.type;
        if (!m.has(r.key)) m.set(r.key, r.type);
        else if (m.get(r.key) !== r.type) m.set(r.key, null);
      }
      for (const n of db.prepare(
        `SELECT DISTINCT qname, name FROM nodes
           WHERE kind IN ('class','interface','struct','type')`).all()) {
        receiverTypeCache.known.add(n.qname);
        receiverTypeCache.known.add(n.name);
      }
    }
    const { type, known } = receiverTypeCache;
    let written = null;
    if (fieldKey.startsWith('#static:')) written = fieldKey.slice('#static:'.length);
    else if (fieldKey.includes('#field:')) {
      const field = fieldKey.split('#field:')[1];
      const cls = fieldKey.split('#field:')[0].split('|').pop();
      written = type.get(fieldKey) ?? type.get(`${cls}#field:${field}`);
    } else written = type.get(fieldKey);
    // One hop through a repo function's declared result. httpx writes
    // `response_complete = create_event()` and `def create_event() -> Event`,
    // where Event is asyncio's — so the receiver's type IS written down, two
    // facts apart, and both of them are read from the source. Without the hop
    // the row is listed as work for the reader; with it the report can say the
    // receiver is not this repo's and count it in one line.
    if (written?.startsWith('#ret:')) {
      const callee = written.slice('#ret:'.length);
      // A constructor call names the type outright: `cid = CaseInsensitiveDict()`
      // makes cid a CaseInsensitiveDict whether or not that class declares the
      // method being asked about. requests inherits `update` from
      // MutableMapping, so nothing resolves — and four `cid.update(...)` rows
      // were landing in the gap list of `RequestsCookieJar.update`, which they
      // can never be a call of.
      const declared = known.has(callee) ? callee : type.get(`${callee}#ret`);
      written = declared && !declared.startsWith('#') ? declared : null;
    }
    if (!written || written.startsWith('#')) return null;
    const names = new Set();
    // One alias hop, then the name itself and its tail, then one embed hop.
    const add = (n) => { if (n) { names.add(n); names.add(n.split('.').pop()); } };
    add(written);
    // A smart pointer stands in for what it points at: `shared_ptr<Sink> s;` makes
    // `s->emit()` a call on `Sink`. Unwrap it before deciding whose type this is, or
    // a real call site gets filed under "library" and leaves the report. Measured on
    // spdlog: `sub_sink->log(msg)` in dist_sink.h is written `std::shared_ptr<sink>`
    // and is a true call site of `sinks::sink::log`.
    const ptr = /(?:^|[.:])(?:shared_ptr|unique_ptr|weak_ptr|auto_ptr)\s*<\s*([\w.:]+)/.exec(written);
    if (ptr) add(ptr[1].replaceAll('::', '.').replace(/[*&]+$/, ''));
    const alias = type.get(`#alias:${written.split('.').pop()}`);
    add(alias);
    for (const n of [...names]) add(type.get(`${n}#embed`));
    return { names, repo: [...names].some((n) => known.has(n)) };
  };

  const collectGaps = (symbols) => {
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
    let matched = [];
    for (const names of chunk(allNames, 400)) {
      const stmt = db.prepare(gapRowsByNameSql(names.length));
      matched.push(...stmt.all(...names, ...names));
    }
    // A call written in another language can never be the missing answer. The
    // rows were matched by name alone, and on re2 — a C++ library with a Python
    // binding — that put seven Python calls to an unrelated `Match` into the
    // first twenty rows of a C++ symbol's gap list. A longer banner nobody
    // believes is worse than a shorter one. With no target found there is no
    // language to filter by, so that case keeps every row.
    //
    // "Another language" does not mean "another file extension". ts and js are one
    // family here, for the reason `langFamily` gives. Measured on axios: the eight
    // `.ts` call sites of a `js` method were dropped by this filter, so the banner
    // said the answer was complete while missing 8 of 25 — and the rule reads that
    // banner as "stop, do not grep".
    const langs = new Set(symbols.map((s) => s.lang).filter(Boolean).map(langFamily));
    if (langs.size) matched = matched.filter((r) => langs.has(langFamily(r.lang)));
    // A call whose receiver type the SOURCE writes down, and writes down as some
    // other type, is not a missing call site of this target. That is not a guess
    // about the call — it is the type on the declaration, the same fact the
    // resolver reads. Measured on nest: `callers "PipesContextCreator.create"`
    // found all four of its call sites and then listed 168 other `create` calls,
    // which sends the reader to grep and costs exactly what having no graph costs.
    // Measured on caddy: seven of the eighteen rows on
    // `callers "caddyhttp.Handler.ServeHTTP"` were calls on `http.Handler` or on a
    // concrete middleware, and none of them could ever have been the target.
    //
    // What it does NOT rule out: a receiver the source never types, a type that
    // embeds the target's type (a promoted method is a real target), and a type from
    // OUTSIDE the repo. That last one is deliberate: a call on a library type is
    // refused by the resolver and reported, which is a tested, published promise,
    // and it is also the one case where a repo type could still be behind the value
    // at run time through an interface whose method set this reader cannot see.
    // Rows the source types as a LIBRARY receiver. Kept — the promise above — but
    // labelled, so the report counts them in one line instead of listing them under
    // a heading that tells the reader to grep. Measured on re2: 204 of the 290 rows
    // on `callers "re2.Prog.size"` are `size()` on a `std::vector` or an
    // `absl::string_view`, and that banner cost the run $0.69 and 184 seconds more
    // than having no graph at all.
    const libraryRows = new Set();
    const owners = new Set(symbols.flatMap((s) => s.owners ?? []));
    if (owners.size) {
      matched = matched.filter((r) => {
        const written = writtenReceiver(r.field_key);
        if (!written) return true;
        if (!written.repo) { libraryRows.add(`${r.file}|${r.line}|${r.dst_name}`); return true; }
        if ([...written.names].some((n) => owners.has(n))) return true;
        // The written type is a repo type and it is not the target's owner. For
        // most languages that settles it — see DROP_ON_OTHER_TYPE, which lists
        // the ones whose inheritance or embedding this indexer reads. C++ is not
        // one of them, so the row stays as an honest gap: a subclass receiver is
        // indistinguishable from an unrelated one here, and a short answer that
        // says `complete` is worse than a listed row.
        //
        // This cannot bring back the banners the drop was built for. re2's 204
        // `std::vector::size` rows are LIBRARY receivers and never reach this
        // line, and a repo class that owns the name resolves the call outright,
        // so it is not a gap candidate at all — both cases are tested in
        // cpp-base-class-gaps.test.ts.
        return !DROP_ON_OTHER_TYPE.has(r.lang);
      });
    }
    const candidates = candidatesByLangBare(matched);
    const qualifierKnown = qualifiersByLangQualifier(matched);

    // Pass 2: classify each row from the two lookup maps instead of a
    // per-row correlated subquery.
    for (const r of matched) {
      const key = `${r.file}|${r.line}|${r.dst_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Both maps are keyed by family, so read them by family. Keyed by exact
      // lang, a `.ts` call to a `.js` method scored 0 candidates and was thrown
      // out of the list as `external` right after the filter above had saved it.
      const fam = langFamily(r.lang);
      const candidateCount = r.external === 1 ? 0 : (candidates.get(`${fam}|${r.dst_bare}`) ?? 0);
      const dot = r.dst_name.indexOf('.');
      const known = dot === -1 ? 1 : (qualifierKnown.get(`${fam}|${r.dst_name.slice(0, dot)}`) ?? 0);
      const reason = libraryRows.has(key) ? 'library'
        : (candidateCount > 0 && known ? 'ambiguous' : 'external');
      out.push({
        file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
        reason,
        reachable: (reason === 'ambiguous' || reason === 'library') && r.lang === 'go'
          ? reachableIn(r.file, pkgForRow(r)) : 1,
      });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };

  // The name variants and package for one symbol, as collectGaps needs them.
  // A missing target (no node found) still has to run one gapRows pass under
  // the raw string the caller asked for — no package to score against.
  // `owners` is the type a call would have to be written on to reach this symbol:
  // the qname minus its own name. The gap report uses it to drop a row whose
  // receiver type the source names as something else.
  const symbolOf = (name, node) => {
    if (!node) return { names: [String(name)], pkg: null, lang: null, owners: [] };
    // Both forms, because Go writes a package-qualified type on a declaration
    // (`*foo.X`) while TypeScript writes a bare one (`CatsService`).
    const dot = node.qname.lastIndexOf('.');
    const ownerQname = dot > 0 ? node.qname.slice(0, dot) : null;
    return { names: [String(name), node.name, node.qname], pkg: goPackageOf(node), lang: node.lang,
             owners: ownerQname ? [ownerQname, ownerQname.split('.').pop()] : [] };
  };

  // A call site records whatever the source wrote, so match the target's bare
  // name as well as its qname — that is what finds a call made through an import
  // alias, a shadowed package name, or a receiver-qualified guess that missed.
  //
  // The target itself is resolved with targetsFor, not store.node: a bare name
  // (the natural thing to type after `search`) can match several symbols, and
  // every one of them may have its own gap rows. Matching only by id/qname
  // (store.node) silently dropped a whole gap report for a bare-name query — 184
  // rows on a real repo, back when a file-scope call was still reported here.
  // See the comment on namesTarget above.
  // Call sites that reach a CONCRETE method through an interface it implements.
  //
  // Indexing interface methods answered a question that could not be asked before
  // — `callers "caddyhttp.Handler.ServeHTTP"` used to say "no symbol named …" — but
  // on its own it would have taken something away. A call written on an interface
  // used to sit unresolved in the gap report of every implementation, warning the
  // reader that something reaches the method which no static tool can name. Once
  // the call resolves to the interface, it is no longer unresolved, and that
  // warning would just vanish: `callers "Postgres.ListGroups"` would read "no
  // callers ✓ complete" for a method that runs on every request.
  //
  // So it is kept, and it says more than it used to. It used to say "2 call sites
  // missing, go and grep"; it now NAMES the interface the calls go through, which
  // is something a text search cannot work out at all.
  //
  // "Implements" here is two checks, not one. First: the type must have a method
  // of every name the interface declares — structural, so it works for
  // TypeScript too, `implements` clause or not. Second (in interfaceReach and
  // implementationReach below): the one method the question is about must also
  // match the interface's shape for that method — see sigShape.
  //
  // Known gap: this misses methods an interface gains by embedding another
  // interface. Go: `type X interface { Reader; Foo() }` — `go.scm` makes a
  // node only for a plain method line (a `method_spec`); an embedded name is
  // a different tree shape (a `constraint_elem`) and is not read. TypeScript
  // has the same gap: `interface X extends Y { foo(): void }` — `ts.scm`
  // reads no member off an `extends` clause either. So `need` for `X` above
  // is just `['Foo']` (or `['foo']` in TypeScript), and a type with only that
  // one method reads as implementing `X` even though `X` also needs
  // everything the embedded or extended interface promises. Both are common.
  // Reading either is future work, not done here.
  //
  // Optional members, TypeScript only: an optional member (`after?(): void`)
  // is left out of `need` below, because a type may skip it and still
  // implement the interface.
  //
  // `sigShape` still returns null for such a member's OWN shape — it reads the
  // `?` as "no parameter list here" — but that no longer costs the answer
  // anything. An unreadable shape falls back to the name-only rule rather than
  // refusing, so a call reaching the optional method IS confirmed: on
  // `Hooks { before(v): string; after?(): void }` with a `class Impl`,
  // `callers Impl.after` reports `reaches this method through Hooks.after`.
  // This paragraph used to say the opposite, and it was read as a limitation
  // worth defending. It was not one.
  // A method's owning type, and every method name that type carries. Two shapes,
  // because Go states the owner in the qname while every other language nests it:
  //   nested   `Json.serialize`  -> container_id points at the class
  //   Go       `store.Postgres.ListGroups` -> no container at all; the receiver is
  //            written into the qname, so the owner is the qname minus its own name
  //            and the method set is every qname under that prefix.
  const ownerOf = (node) => {
    if (node.container_id) {
      const o = db.prepare('SELECT id, qname, kind FROM nodes WHERE id = ?').get(node.container_id);
      if (!o) return null;
      return { ...o, names: db.prepare('SELECT name FROM nodes WHERE container_id = ?')
        .all(o.id).map((r) => r.name) };
    }
    if (!node.qname?.includes('.')) return null;
    const ownerQname = node.qname.slice(0, node.qname.lastIndexOf('.'));
    const o = db.prepare('SELECT id, qname, kind FROM nodes WHERE qname = ? AND lang = ? LIMIT 2')
      .all(ownerQname, node.lang);
    if (o.length !== 1) return null; // two types on one qname: no method set to trust
    // `qname = prefix || name` instead of a LIKE: it picks exactly this type's own
    // methods and never `x.y.z.w`, a method of something nested one level deeper.
    // It also needs no escaping, and a Go qname can hold `_`, which LIKE would read
    // as a wildcard.
    const prefix = `${ownerQname}.`;
    const names = db.prepare(
      `SELECT name FROM nodes WHERE lang = ? AND qname = ? || name
         AND kind IN ('function','method')`).all(node.lang, prefix.replace(/\\(.)/g, '$1'))
      .map((r) => r.name);
    return { ...o[0], names };
  };

  // True for a TypeScript interface member written with `?` — `after?(): void`,
  // `after?: () => void`, `after?<T>(v: T): void`, or with a space before the
  // `?` (`after ?(): void`, which TypeScript also allows). A type may leave
  // an optional member out and still legally implement the interface.
  //
  // The stored `signature` is the raw source line, but the name does not
  // always start it — `readonly after?: () => void` keeps `readonly` in
  // front, and the old code, which just read the character at `name.length`,
  // read `readonly`'s own `n` there and missed the `?` entirely. So the name
  // is located the same boundary-checked way `sigShape` finds it (the
  // character before it must not continue an identifier, and neither must
  // the character after), not assumed to sit at a fixed offset. Once found,
  // only the text right after it is checked for a `?`, allowing whitespace.
  const isOptionalMember = (member) => {
    const { signature, name } = member;
    if (typeof signature !== 'string' || !name) return false;
    for (let at = signature.indexOf(name); at !== -1; at = signature.indexOf(name, at + 1)) {
      const after = at + name.length;
      if (/[\w$]/.test(signature[after] ?? '')) continue; // a longer identifier, not this name
      if (/[\w$.]/.test(signature[at - 1] ?? '')) continue; // part of a longer identifier
      return /^\s*\?/.test(signature.slice(after));
    }
    return false;
  };

  // Does an implementation's shape for one method satisfy the interface's shape
  // for the same method? `lang` picks the rule; `ifaceShape` and `implShape` are
  // whatever `sigShape` returned for the interface's member and the candidate
  // method — either may be `null`.
  //
  // Go's compiler demands an exact signature, so an exact comparison is right
  // there: measured on caddy (701 name-set pairs at schema 13), it is the rule
  // that keeps the three-parameter `MiddlewareHandler` form and the void
  // standard-library form OUT of `ServeHTTP`'s answer — both real distinctions
  // this study depends on.
  //
  // TypeScript is structurally typed and looser in two ways an exact match gets
  // wrong: an implementation may declare FEWER parameters than the interface
  // (`transform(value)` legally implements `transform(value, metadata)`), and a
  // return annotation is optional on the class side (`catch(exception, host) {`
  // legally implements `catch(exception: T, host: ArgumentsHost): any;`).
  // Measured on nest (660 pairs, same schema): the exact rule refuses 597 of
  // them, and 217 of those refusals are calls that really run through the
  // interface — dropping the `ℹ` row that says so and printing `✓ complete`
  // for a method a call really reaches.
  //
  // A shape that could not be read must never mean "refuse". `sigShape` returns
  // `null` for a generic method, a callback-typed member, an optional member,
  // or a declaration whose parameter list wraps onto the next line — 144 of
  // nest's 283 interface members (51%) have no readable shape at all. Falling
  // back to the name-only rule here costs nothing: the `ℹ` row this produces
  // can never be mistaken for a certain caller, so there is no false claim to
  // make by letting it through. Refusing it instead would manufacture a false
  // `✓ complete`, which is the one claim this file must never make by mistake.
  const shapeSatisfies = (lang, ifaceShape, implShape) => {
    if (!ifaceShape || !implShape) return true; // unreadable: fall back to name-only
    if (lang === 'go') {
      // Untouched: a Go implementation must repeat the `...` itself, so a
      // variadic member already compares correctly under plain equality —
      // `Printf(format string, args ...any)` reads as the same params/result
      // shape on both the interface and the implementing method.
      return ifaceShape.params === implShape.params && ifaceShape.hasResult === implShape.hasResult;
    }
    // TS/JS: fewer params is fine, a result annotation is optional. A rest
    // parameter on the INTERFACE side (`...optionalParams: any[]`) means "any
    // number more", not "at most this many", so the count check does not
    // apply at all once the interface member is variadic. Measured on nest:
    // `LoggerService.error(message, ...optionalParams)` (2 params) is
    // implemented by `CustomLogger.error(message, trace?, context?)` (3
    // params) — exactly what NestJS's own docs tell you to write for a
    // custom logger — and the old `implShape.params <= ifaceShape.params`
    // rule refused it. Of the 44 refusals left after that fix, 6 have a rest
    // parameter on the interface side, 5 of those carry calls, and together
    // they were dropping 20 `ℹ` rows.
    if (ifaceShape.variadic) return true;
    return implShape.params <= ifaceShape.params;
  };

  const interfaceReach = (node) => {
    if (!node?.name) return [];
    const owner = ownerOf(node);
    if (!owner || owner.kind === 'interface') return [];
    const ownNames = new Set(owner.names);
    const implShape = sigShape(node.signature, node.name);
    // Only interfaces that declare a method of this name can be relevant.
    // ORDER BY o.qname: when two interfaces both carry a method of this name,
    // this decides which one's "ℹ" group is reported first, and that must
    // not depend on SQLite's unordered row delivery.
    const ifaces = db.prepare(`
      SELECT DISTINCT o.id, o.qname FROM nodes n JOIN nodes o ON n.container_id = o.id
      WHERE o.kind = 'interface' AND o.lang = ? AND n.name = ? AND o.id <> ?
      ORDER BY o.qname`)
      .all(node.lang, node.name, owner.id);
    const out = [];
    for (const iface of ifaces) {
      // ORDER BY start_line: a stable order for the members of one interface,
      // and the same order the overload scan below relies on being stable.
      const members = db.prepare(
        'SELECT name, signature FROM nodes WHERE container_id = ? ORDER BY start_line')
        .all(iface.id);
      // An optional member does not have to be there, so it is not demanded.
      const need = members.filter((m) => !isOptionalMember(m)).map((m) => m.name);
      if (!need.length || !need.every((n) => ownNames.has(n))) continue;
      // Compared with shapeSatisfies — see its comment for the Go/TypeScript
      // split and why an unreadable shape falls back to name-only instead of
      // refusing. Without some shape check at all, a one-parameter
      // `Cache.ListGroups(reset bool)` read as satisfying a zero-parameter
      // `Store.ListGroups() []string`, on name alone.
      //
      // A TypeScript interface can declare one name more than once — overloads.
      // A type that implements ANY of the declared shapes satisfies the
      // interface, so compare against every same-named member and stop at the
      // first that agrees. Taking only the first member refused a class that
      // implemented the second overload, and then reported "no callers,
      // complete" for a method that every call reaches.
      const candidates = members.filter((m) => m.name === node.name);
      const matches = candidates.some((m) => shapeSatisfies(node.lang, sigShape(m.signature, m.name), implShape));
      if (!matches) continue;
      for (const r of db.prepare(`
        SELECT e.file, e.line, e.dst_name, s.qname AS src_qname, n.qname AS via
        FROM edges e JOIN nodes n ON n.id = e.dst_id
        LEFT JOIN nodes s ON s.id = e.src_id
        WHERE e.kind = 'call' AND n.container_id = ? AND n.name = ?
        ORDER BY e.file, e.line`).all(iface.id, node.name)) {
        out.push({ file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
          reason: 'interface', reachable: 1, via: r.via });
      }
    }
    return out;
  };

  // The mirror of interfaceReach. Asked about a method an INTERFACE declares,
  // find the types that implement the interface and report the calls that land on
  // their method. Those calls resolve certainly — the receiver's type is written
  // at the call site — so they are knowledge the reader would otherwise have to
  // grep for.
  //
  // Measured on caddy: `callers caddyhttp.Handler.ServeHTTP` named 1 of the 18
  // calls in modules/caddyhttp/metrics_test.go. The other 17 resolve to
  // `metricsInstrumentedRoute.ServeHTTP`, which is the right answer to "which
  // method runs" and the wrong answer to the question that was asked.
  //
  // Satisfaction is checked two ways: the type must carry every method name the
  // interface declares (the comment above ownerOf says what this misses with an
  // embedded interface), PLUS the one method being asked about must match the
  // interface's shape for it. The name alone is not enough here: caddy holds 34
  // methods named `ServeHTTP` in three shapes, and a question about the
  // two-parameter form that returns an error is not a question about the
  // three-parameter middleware form or about the standard library's form that
  // returns nothing.
  const implementationReach = (node) => {
    if (!node?.name || !node.container_id) return [];
    const iface = db.prepare('SELECT id, qname, kind FROM nodes WHERE id = ?').get(node.container_id);
    if (!iface || iface.kind !== 'interface') return [];
    // Loop-invariant, so read once before the candidate scan runs. May be
    // `null` — an unreadable interface shape no longer means "refuse every
    // candidate"; shapeSatisfies falls back to name-only for it below.
    const ifaceShape = sigShape(node.signature, node.name);
    // Before the optional filter below, `need` always held at least
    // `node.name`, because `node.container_id` is `iface.id` — node is one
    // of the rows this query selects. That stopped being true the moment
    // optional members started being filtered out: `need` comes back empty
    // whenever EVERY member is optional. The common case is `node` being the
    // interface's only member, but nest has 28 all-optional interfaces
    // carrying 36 members between them, so some of them declare several.
    // An empty `need` must never mean "every candidate implements" —
    // `[].every(...)` is always true, so without the check right below,
    // every same-named method anywhere would pass the name-set gate. The
    // guard mirrors interfaceReach's own `!need.length` check, for the same
    // reason. An optional member does not have to be there, so it is not
    // demanded — a type may legally implement the interface without it.
    const need = db.prepare('SELECT name, signature FROM nodes WHERE container_id = ?')
      .all(iface.id)
      .filter((m) => !isOptionalMember(m))
      .map((m) => m.name);
    if (!need.length) return [];
    const rowsFor = db.prepare(`
      SELECT e.file, e.line, e.dst_name, s.qname AS src_qname
      FROM edges e LEFT JOIN nodes s ON s.id = e.src_id
      WHERE e.kind = 'call' AND e.dst_id = ? ORDER BY e.file, e.line`);
    const out = [];
    // ORDER BY qname: candidates decide which row wins a dedup key shared with
    // another candidate's row on the same file:line (see addOnce), and that
    // choice must not depend on SQLite's unordered row delivery.
    for (const cand of db.prepare(`
      SELECT id, qname, signature, name, lang, container_id FROM nodes
      WHERE name = ? AND lang = ? AND kind IN ('function','method') AND id <> ?
      ORDER BY qname`)
      .all(node.name, node.lang, node.id)) {
      const owner = ownerOf(cand);
      if (!owner || owner.kind === 'interface') continue;
      const ownNames = new Set(owner.names);
      if (!need.every((n) => ownNames.has(n))) continue;
      // See shapeSatisfies above interfaceReach for the Go/TypeScript split
      // and why a shape that could not be read falls back to name-only.
      if (!shapeSatisfies(node.lang, ifaceShape, sigShape(cand.signature, cand.name))) continue;
      for (const r of rowsFor.all(cand.id)) {
        out.push({ file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
          reason: 'implementation', reachable: 1, via: cand.qname });
      }
    }
    return out;
  };

  // Adds each row of `extra` to `rows`, at most once, sharing the `seen` set
  // with the caller. `seen` starts out holding the file:line of every row
  // `collectGaps` already reported, so a reach row for a line already listed
  // as a plain gap is dropped — the two would say the same thing twice, in
  // different words.
  //
  // Keyed on `file|line|reason|via`, not `file|line` alone, once a row is
  // added here: two implementations can be called on the SAME line —
  // `append(p.ListGroups(), m.ListGroups()...)` names both `p` and `m` on one
  // line — and that is two different facts, each with its own `via`. A
  // `file|line` key would keep only whichever row the database happened to
  // return first and silently drop the other. Shared by store.gapsFor and
  // store.gapsAround so the rule lives in one place.
  const addOnce = (rows, seen, extra) => {
    for (const r of extra) {
      const shortKey = `${r.file}|${r.line}`;
      const fullKey = `${shortKey}|${r.reason}|${r.via}`;
      if (seen.has(shortKey) || seen.has(fullKey)) continue;
      seen.add(fullKey);
      rows.push(r);
    }
  };

  store.gapsFor = (name) => {
    if (!hasBare) return [];
    const targets = targetsFor(name);
    if (!targets.length) return collectGaps([symbolOf(name, null)]);
    // A call written at file scope is not reported here at all. `store.callers`
    // above already returns one `kind: 'file'` row per file that holds such a
    // call, with every line on it. Reporting the same lines here too made the
    // answer contradict itself, and the ⚠ heading say "missing" about lines the
    // reader had just read. The rows are also capped at 20 in the banner and
    // uncapped in the list — measured on hugo, `parse.mkItem` has 120 of them, so
    // 100 were replaced by "… and 100 more". Same in `gapsAround` (impact):
    // `store.impact` lists these files too, as leaves of its reverse walk.
    const rows = collectGaps(targets.map((t) => symbolOf(name, t)));
    const seen = new Set(rows.map((r) => `${r.file}|${r.line}`));
    for (const t of targets) {
      addOnce(rows, seen, interfaceReach(t));
      addOnce(rows, seen, implementationReach(t));
    }
    return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };
  store.gapsFrom = (name) => {
    if (!hasBare) return [];
    // targetsFor, not store.node: `store.callees` matches the caller by id, bare
    // name or qname, so this report has to match the same way. Through store.node
    // (id or qname only) a bare-name question got NO gap report at all, and the
    // answer then claimed to be complete. Measured on a two-class fixture:
    // `callees T.do` said `⚠ 1 call site missing`, `callees do` said `✓ complete`
    // about the same method.
    const targets = targetsFor(name);
    if (!targets.length) return [];
    const ids = targets.map((t) => t.id);
    // The language family, same as collectGaps — `callees` and `callers` have to
    // agree about one row. A line that is a gap read one way and not the other is
    // its own bug, and the reader has no way to tell which answer to believe.
    return db.prepare(`
      SELECT e.dst_name, e.dst_bare, e.file, e.line, e.external, e.lang,
             s.qname AS src_qname,
             (SELECT count(*) FROM nodes n2
              WHERE n2.name = e.dst_bare AND ${SAME_LANG('n2.lang', 'e.lang')}
                AND n2.kind IN ('function','method','class')) AS candidates,
             ${QUALIFIER_KNOWN_SQL('e.dst_name', 'n3', 'e.lang')} AS qualifier_known
      FROM edges e JOIN nodes s ON s.id = e.src_id
      WHERE e.kind = 'call' AND e.dst_id IS NULL AND e.src_id IN (${holes(ids.length)})
      ORDER BY e.file, e.line`).all(...ids).map((r) => ({
        file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
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
  // several symbols. The walk still starts from one node at a time (a frontier is
  // a per-symbol call graph, blending several would confuse the walk), so run it
  // once per matched target and merge the frontiers. A node already counted as a
  // target is dropped from the merged "reached" set so it does not also show up
  // as its own reached neighbour.
  //
  // impactNodes, not store.impact: the node rows are the frontier, and a file is
  // not a symbol — `symbolOf` would read `app/boot.js` as a qname and hand the
  // gap report `app/boot` as an owner type to match call receivers against. A
  // file-scope call is a leaf too, so it hides no further frontier anyway.
  store.gapsAround = (name) => {
    if (!hasBare) return [];
    const targets = targetsFor(name);
    if (!targets.length) return collectGaps([symbolOf(name, null)]);
    const targetIds = new Set(targets.map((t) => t.id));
    const reachedById = new Map();
    for (const t of targets) {
      for (const n of impactNodes(t)) {
        if (!targetIds.has(n.id)) reachedById.set(n.id, n);
      }
    }
    const reached = [...reachedById.values()];
    const symbols = [...targets.map((t) => symbolOf(name, t)), ...reached.map((n) => symbolOf(n.qname, n))];
    // No file-scope call is reported here, the same reason as gapsFor:
    // `store.impact` returns a `kind: 'file'` row for every such file, so
    // those call sites are IN the answer. Naming them again under ⚠ made `impact`
    // print `(no impact)` and then list two lines that really do break — a false
    // headline rescued by a banner, and a flat disagreement with `callers` on the
    // same symbol. A GUESSED file-scope call is not listed, because the walk
    // refuses guesses; store.impactSkippedGuesses counts it, which blocks
    // ✓ complete just as firmly as a gap row did.
    const rows = collectGaps(symbols);
    // The same interface and implementation lines the direct question gets. An
    // impact walk that stops at a concrete method — or that asks about an
    // interface method directly — has to say what reaches it, or the set reads
    // as closed.
    const seen = new Set(rows.map((r) => `${r.file}|${r.line}`));
    for (const t of targets) {
      addOnce(rows, seen, interfaceReach(t));
      addOnce(rows, seen, implementationReach(t));
    }
    return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };
  const MAX_DEPTH = 50;
  // The reverse walk itself: the target, then whatever calls it, and so on. Held
  // in one place because three queries below must read the same frontier — the
  // node rows, the file-scope rows and the count of refused guesses. If they
  // disagreed, the answer would name a node the count did not cover.
  //
  // Seeded from a LIST of ids, not one. A bare name can mean several symbols, and
  // `impact` answers for all of them, the same as `callers` does. The walk from a
  // set of seeds reaches exactly the union of the walks from each seed, so one
  // query answers for the whole set.
  const upCte = (n) => `
      WITH RECURSIVE up(id, depth) AS (
        SELECT id, 0 FROM nodes WHERE id IN (${holes(n)})
        UNION
        SELECT e.src_id, up.depth + 1 FROM edges e
        JOIN up ON e.dst_id = up.id
        WHERE up.depth < ${MAX_DEPTH} AND e.src_id IS NOT NULL ${GUESS_FILTER}
      )`;
  // The node rows of the walk from ONE symbol. Kept apart from store.impact so
  // store.gapsAround can walk from a node it has already resolved, instead of
  // resolving the same name a second time.
  //
  // `guess` and `call_sites` keep ONE row shape in the JSON array. A file row
  // carries both; a node row carried neither, so a consumer reading
  // `json.impact.map((r) => r.call_sites.length)` threw as soon as the walk
  // returned a node. Both are additive — `--json` is a contract, so no existing
  // field changes value or disappears — and both say something true:
  //   `guess: 0`      the walk follows certain edges only (GUESS_FILTER), so
  //                   every node it reached is certain by construction.
  //   `call_sites: []` this walk reports WHICH symbols break, not where each one
  //                   writes its call. `callers` is the command that reports call
  //                   sites, and it fills this key in.
  const impactNodes = (target) => db.prepare(`${upCte(1)}
      SELECT DISTINCT n.* FROM nodes n JOIN up ON n.id = up.id
      WHERE n.id != ?`).all(target.id, target.id).map((n) => ({ ...n, guess: 0, call_sites: [] }));
  store.impact = (name) => {
    // targetsFor, not store.node: store.node matches an id or a qname and never a
    // bare name, so `impact Root` returned [] for every Go function and for every
    // method in any language — and the answer then said `✓ complete` over
    // nothing, on the path the shipped rule tells the agent to use.
    const targets = targetsFor(name);
    if (!targets.length) return [];
    // One walk per matched symbol, merged by node id. A node reached from two
    // same-named targets is one answer, not two — the same rule `callers` follows
    // when it groups its rows by the caller's id.
    //
    // Each walk excludes its OWN start and no other, so a symbol that shares the
    // name AND calls the other one still shows up as impacted — which is what
    // `callers` reports for the same pair.
    const byId = new Map();
    for (const t of targets) {
      for (const r of impactNodes(t)) if (!byId.has(r.id)) byId.set(r.id, r);
    }
    // A call written outside any function breaks when the target changes, so it
    // belongs in "what breaks if I change X" — but nothing calls a top-level
    // statement, so it is a LEAF: it ends the chain instead of extending it.
    // `impact` used to print `(no impact)` and then name those lines under the ⚠
    // banner. The headline was false, the banner rescued it, and `callers` on the
    // same symbol already listed them — the two commands disagreed.
    //
    // `e.dst_id IN (SELECT id FROM up)`, not just the target: `up` holds the
    // target AND everything the walk reached, and a top-level call landing on any
    // of them breaks too. `m.eject(1)` at module scope and `mid()` at module
    // scope, where `mid` calls `eject`, are both real answers.
    //
    // Asked ONCE for every target, not once per target, because SQL is where the
    // grouping happens: one file holding a top-level call to two same-named
    // targets must come out as one row carrying both lines. Merging per-target
    // rows in JS would have to redo that grouping, and getting it wrong drops a
    // real call site under `✓ complete`.
    //
    // GUESS_FILTER, the same rule the walk above follows. A guessed row here
    // would sit in a flat list next to certain ones with nothing to tell them
    // apart, and `impact` exists to answer without false alarms. The refused ones
    // are counted by store.impactSkippedGuesses instead, which blocks ✓ complete.
    const ids = targets.map((t) => t.id);
    const fileRows = withSites(db.prepare(fileScopeSql(
      `e.dst_id IN (SELECT id FROM up) ${GUESS_FILTER}`, upCte(ids.length))).all(...ids).map(asFileRow));
    // Node rows first, file rows last: a reader scans the top of a list.
    return [...byId.values(), ...fileRows];
  };
  // How many guessed edges the walk above refused to follow, for this one
  // target. `impact` returning [] means one of two very different things:
  // nothing depends on this symbol, or the only paths in were guesses the
  // walk would not take. A caller cannot tell which from an empty array
  // alone, so count it: same walk, same set of certainly-reached nodes (the
  // target plus everything store.impact returns), and this counts every
  // guessed edge landing on one of them — the exact set of edges the filter
  // in store.impact turned away.
  //
  // Every guessed edge, with a caller or without one. It used to skip
  // `src_id IS NULL`, and that was right while `impact` could not show a
  // file-scope call at all: the walk never had such an edge to refuse, and the
  // call was reported as a `no-caller` gap row instead. Now `impact` lists the
  // certain file-scope calls, so a guessed one IS a path it refused — and it is
  // no longer in the gap report. Counting it here is the only thing that stops
  // an empty list plus `✓ complete` over a real call site the graph could not
  // settle.
  //
  // Resolved with targetsFor, exactly like store.impact: with store.node here the
  // count and the walk described different targets, so a bare-name question got
  // an empty list, a count of 0 and `✓ complete` over a call site the graph could
  // not settle. One walk over all the matched targets, not a sum of per-target
  // counts — a sum would count the same guessed edge twice when two targets reach
  // the same node.
  store.impactSkippedGuesses = (name) => {
    if (!hasGuess) return 0; // no column, so nothing on this DB is a guess
    const ids = targetsFor(name).map((t) => t.id);
    if (!ids.length) return 0;
    return db.prepare(`${upCte(ids.length)}
      SELECT count(*) AS c FROM edges e JOIN up ON up.id = e.dst_id
      WHERE e.guess = 1`).get(...ids).c;
  };
  // How X reaches Y, and how sure each step is. Returns
  // `{ path: [qname, …], guessed: [bool, …] }` with one flag per ARROW, so
  // `guessed` is always one shorter than `path`; null when there is no path.
  //
  // Guessed hops are MARKED, not dropped. A path built partly from guesses is
  // still the best lead the graph has; a path silently missing would read as
  // "there is no way from X to Y", which is a much stronger claim than the
  // graph can make. `impact` refuses a guess because it answers "what breaks"
  // — a wrong entry there is a false alarm a reader cannot check. `trace`
  // hands back a concrete route the reader can open and confirm, so marking it
  // is enough.
  //
  // A certain route wins over a guessed one even when it is longer: the search
  // runs first over certain edges only, and falls back to all edges. Two edges
  // between the same pair collapse to the more certain one (MIN), because the
  // hop is then real however the other edge was resolved.
  //
  // BOTH ends are resolved with targetsFor, for the reason on namesTarget above:
  // store.node matches an id or a qname and never a bare name. Measured on a Go
  // graph where app.Mid calls svc.Root, `trace Mid Root` printed `(no path)` while
  // `trace app.Mid svc.Root` printed the path. That is the worst shape a wrong
  // answer can take here: no banner, exit 0, and the skill tells the agent that
  // `(no path)` means the graph looked along resolved calls and found nothing.
  // ALL the matched starts seed ONE breadth-first walk and it stops at the first
  // matched end, so a shared name costs no extra pass, and the route it prints
  // names the pair it used.
  store.trace = (fromName, toName) => {
    const fromIds = targetsFor(fromName).map((t) => t.id);
    const toIds = new Set(targetsFor(toName).map((t) => t.id));
    if (!fromIds.length || !toIds.size) return null;
    const edges = db.prepare(`
      SELECT src_id, dst_id, ${hasGuess ? 'MIN(guess)' : '0'} AS guess FROM edges
      WHERE dst_id IS NOT NULL AND src_id IS NOT NULL
      GROUP BY src_id, dst_id`).all();
    const next = new Map();
    for (const e of edges) {
      if (!next.has(e.src_id)) next.set(e.src_id, []);
      next.get(e.src_id).push({ id: e.dst_id, guess: e.guess === 1 });
    }
    // Breadth-first, so the route found is the shortest one this edge set
    // allows. `hops` holds the guess flag of the arrow that led to each node
    // after the first, so it is always one shorter than `ids`.
    const walk = (certainOnly) => {
      const q = fromIds.map((id) => ({ ids: [id], hops: [] })), seen = new Set(fromIds);
      while (q.length) {
        const cur = q.shift();
        const last = cur.ids[cur.ids.length - 1];
        if (toIds.has(last)) return cur;
        for (const nx of next.get(last) ?? []) {
          if (certainOnly && nx.guess) continue;
          if (seen.has(nx.id)) continue;
          seen.add(nx.id);
          q.push({ ids: [...cur.ids, nx.id], hops: [...cur.hops, nx.guess] });
        }
      }
      return null;
    };
    const found = walk(true) ?? walk(false);
    if (!found) return null;
    return { path: found.ids.map((id) => store.node(id).qname), guessed: found.hops };
  };
  store.schemaStale = () => Number(store.getMeta('schema_version')) !== SCHEMA_VERSION;
}

// A database in WAL mode needs to create a "-shm" shared-memory file next
// to it even just to read — SQLite's own rule, not a p-graph choice (see
// sqlite.org/wal.html). That is exactly what a read-only DIRECTORY cannot
// provide (unlike a merely read-only FILE, nothing beside it can be created
// either). The "immutable" URI query parameter tells SQLite the file will
// never change for this connection's lifetime, which skips that requirement
// — it reads the main database file directly, no "-shm"/"-wal" involved
// (sqlite.org/uri.html).
//
// node:sqlite does not document URI support at any version — confirmed to
// work on Node 24.14, not confirmed on Node 22.5, this plugin's own stated
// floor (loadDatabaseSync's error names it). So the URI is tried, never
// trusted: if opening it throws for any reason, fall back to a plain
// read-only open of the file path, which every node:sqlite version
// supports. That plain open cannot skip the "-shm" file, so it still fails
// on a read-only directory on a Node that rejects the URI — there is no
// third way to read WAL data without writing anywhere at all — but it keeps
// every OTHER read-only case (a read-only FILE, a normal open) working
// instead of a hard crash on every older Node. If even the plain open
// fails, this throws that failure rather than returning a fake, empty
// store — a genuinely unreadable database must give one clear error, not
// answer from nothing.
//
// Exported so a test can check the fallback itself, by passing a stub
// DatabaseSync that throws only for the URI form — the one thing this file
// cannot make Node 22.5 actually do in this environment.
export function openReadOnlyConnection(DatabaseSync, dbPath) {
  // ":memory:" is a special name, not a filesystem path — it cannot become
  // a URI, and it never needs "-shm" either.
  if (dbPath === ':memory:') return new DatabaseSync(dbPath, { readOnly: true });
  try {
    return new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
  } catch {
    return new DatabaseSync(dbPath, { readOnly: true });
  }
}

// Open an already-initialized DB for reads only — no WAL pragma, no DDL, no FTS
// creation, no meta writes (all of which would fail on a read-only handle).
// Used as a fallback when the normal (writable, WAL) open fails, e.g. on a
// read-only filesystem, so a query can still answer (and the refresh degrades).
function openReadOnly(DatabaseSync, dbPath) {
  const db = openReadOnlyConnection(DatabaseSync, dbPath);
  let hasFts = false;
  try { db.prepare('SELECT 1 FROM nodes_fts LIMIT 1').get(); hasFts = true; } catch { hasFts = false; }

  // No self-prefix: `die()` in pgraph.mjs is the one place that adds
  // "pgraph: ", and a message that prefixed itself too printed as the
  // double "pgraph: p-graph: store is read-only".
  const readOnlyError = () => { throw new Error('store is read-only'); };
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
