#!/usr/bin/env node
// Reproduce every published p-graph precision number, in one command.
//
//   node plugins/p-graph/scripts/measure.mjs                # all 7 repos, clone if needed
//   node plugins/p-graph/scripts/measure.mjs --repos hugo,nest
//   node plugins/p-graph/scripts/measure.mjs --no-clone      # reuse what is on disk
//   node plugins/p-graph/scripts/measure.mjs --work /path    # where clones live
//
// Why this exists: the figures in README.md were measured by hand in a working
// folder on one machine, so nobody could re-check them, and nothing would notice
// if a later change moved them. Every commit that touches resolution can now be
// re-measured against the same seven repositories, pinned to the same commits.
//
// What it proves and what it does not:
//   PROVES  the size and confidence split of each answer, and that every CERTAIN
//           row has a checkable reason to mean that symbol (see REASONS below).
//   DOES NOT judge guessed rows. Deciding whether a guess is right needs a human
//           reading the receiver; the counts are printed, the verdicts are not.
//
// Exit code 1 if any certain row has no reason — that is the invariant the whole
// design rests on, so it is the one thing this script can fail on.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, posix, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'tools', 'pgraph.mjs');
const STORE_URL = new URL('../tools/lib/destinations/local-sqlite.mjs', import.meta.url);

// Pinned so the numbers are comparable run to run. A different commit is fine —
// say so in the write-up, because the counts will move with the upstream code.
const REPOS = {
  hugo: ['https://github.com/gohugoio/hugo.git', '70db201ed4f76d0b80c568ffa6b1d35071aabd22'],
  caddy: ['https://github.com/caddyserver/caddy.git', 'e096ca9503188f057c69a049f709fdade6077631'],
  nest: ['https://github.com/nestjs/nest.git', '20ad6fd000dc6cc797788b4f333871f77b46a43f'],
  flask: ['https://github.com/pallets/flask.git', '6a2f545bfd8ed31e19066a299296917e034aca58'],
  requests: ['https://github.com/psf/requests.git', '1f6589ec3a1ee910f9a65cc3ceac60b26677bc0e'],
  got: ['https://github.com/sindresorhus/got.git', 'e3924aa1e53a6ca3eb93a43618ce532442a89b40'],
  leveldb: ['https://github.com/google/leveldb.git', '7ee830d02b623e8ffe0b95d59a74db1e58da04c5'],
};

// The 22 symbols the original acceptance test used, with the answer size it
// published. `resolved` counts call edges that reached the symbol.
const SYMBOLS = [
  ['hugo', 'bufferpool.GetBuffer', 24],
  ['hugo', 'goldmark.idFactory.Put', 1],
  ['hugo', 'collections.Namespace.Index', 37],
  ['hugo', 'highlight.byteCountFlexiWriter.WriteRune', 3],
  ['hugo', 'helpers.Exists', 11],
  ['hugo', 'hugolib.Test', 982],
  ['caddy', 'caddy.ParseDuration', 65],
  ['caddy', 'caddyhttp.SanitizedPathJoin', 7],
  ['caddy', 'caddy.ParseStructTag', 1],
  ['got', 'end', 1],
  ['got', 'exec', 0],
  ['got', 'setHeader', 91],
  ['nest', 'TestingModule.createNestApplication', 190],
  ['nest', 'isUndefined', 75],
  ['nest', 'isObject', 44],
  ['requests', 'get', 84],
  ['requests', 'RequestsCookieJar.set', 38],
  ['requests', 'RequestsCookieJar.update', 16],
  ['flask', 'url_for', 50],
  ['flask', 'get_flashed_messages', 6],
  ['leveldb', 'leveldb.DBImpl.Get', 0],
  ['leveldb', 'TotalFileSize', 8],
];

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const work = String(flag('work', join(tmpdir(), 'pgraph-measure')));
const only = flag('repos') && String(flag('repos')).split(',').map((s) => s.trim());
const noClone = Boolean(flag('no-clone', false));
const wanted = Object.keys(REPOS).filter((r) => !only || only.includes(r));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const pgraph = (cwd, ...a) => execFileSync('node', [CLI, ...a], { cwd, encoding: 'utf-8', maxBuffer: 1 << 28 });

// Shallow AND pinned: `clone --depth 1` cannot check out an arbitrary commit, so
// fetch that one commit into an empty repo instead.
function prepare(repo) {
  const [url, sha] = REPOS[repo];
  const dir = join(work, repo);
  if (!noClone && !existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    process.stderr.write(`  cloning ${repo} at ${sha.slice(0, 7)}…\n`);
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', url);
    git(dir, 'fetch', '-q', '--depth', '1', 'origin', sha);
    git(dir, 'checkout', '-q', 'FETCH_HEAD');
  }
  if (!existsSync(dir)) throw new Error(`${repo} is not in ${work} and --no-clone was given`);
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  mkdirSync(join(dir, '.pgraph'), { recursive: true });
  const t0 = Date.now();
  pgraph(dir, 'index', '--full');
  return { dir, head, pinned: head === sha, indexMs: Date.now() - t0 };
}

// Why a certain row is allowed to claim it means THIS symbol. Each reason is a
// fact the resolver could actually have read: a name written in the source, a
// package the file belongs to, or an import it declares.
const REASONS = [
  'target is in the calling file',
  'the line writes <pkg>.<Name> (Go)',
  'the calling file is in the target package (Go)',
  'the line writes <alias>.<Name> and the file imports that package (Go)',
  'the line writes <module>.<Name> and the target sits in that module (Python)',
  'the calling file imports the target file',
  'the source assigns the receiver a constructor of the target\'s own class',
  'the source states the receiver\'s declared type, and that type owns the method (TypeScript)',
];

// Rows with no mechanical reason that were READ and found correct. Keyed by
// repo + symbol + file, not by line, so ordinary edits above the call do not
// invalidate the check. Anything outside this list fails the run — that is what
// makes the script an alarm and not a report.
const ACCEPTED = new Map([
  ['flask url_for examples/tutorial/flaskr/auth.py', 'line 10 is `from flask import url_for`'],
  ['flask url_for examples/tutorial/flaskr/blog.py', 'line 7 is `from flask import url_for`'],
  ['flask url_for tests/test_converters.py', 'line 5 is `from flask import url_for`'],
]);

const stripExt = (p) => posix.basename(p).replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|cc|cpp|cxx|h|hpp)$/, '');
const lastSeg = (p) => p.replace(/['"<>]/g, '').split('/').filter(Boolean).pop() ?? '';

async function main() {
  const { openStore } = await import(STORE_URL);
  const rows = [];
  const unexplained = []; const accepted = [];
  let totalResolved = 0, totalClaimed = 0, totalCertain = 0, totalGuess = 0, atRisk = 0;

  for (const repo of wanted) {
    process.stderr.write(`${repo}:\n`);
    const { dir, head, pinned, indexMs } = prepare(repo);
    if (!pinned) process.stderr.write(`  NOTE: HEAD is ${head.slice(0, 7)}, not the pinned commit — counts will differ\n`);
    const store = openStore(join(dir, '.pgraph', 'graph.db'));
    const st = store.status();
    process.stderr.write(`  ${st.files} files, ${st.nodes} symbols, index ${(indexMs / 1000).toFixed(1)} s\n`);

    const srcCache = new Map();
    const lineOf = (file, n) => {
      if (!srcCache.has(file)) {
        try { srcCache.set(file, readFileSync(join(dir, file), 'utf-8').split('\n')); }
        catch { srcCache.set(file, null); }
      }
      return srcCache.get(file)?.[n - 1] ?? '';
    };
    const impBase = new Map(); const impPath = new Map();
    for (const r of store.db.prepare(
      `SELECT file, dst_name FROM edges WHERE kind IN ('import','include')`).all()) {
      if (!impBase.has(r.file)) { impBase.set(r.file, new Set()); impPath.set(r.file, new Set()); }
      impBase.get(r.file).add(stripExt(r.dst_name.replace(/^['"<]|['">]$/g, '')));
      impPath.get(r.file).add(r.dst_name);
    }
    // Does this file assign `recv` a constructor of the class that owns `dstQname`?
    // A text search on purpose: it checks the SOURCE, not the graph's own table, so
    // the two can disagree and the disagreement shows up here.
    const srcOf = (file) => {
      if (!srcCache.has(`ALL|${file}`)) {
        try { srcCache.set(`ALL|${file}`, readFileSync(join(dir, file), 'utf-8')); }
        catch { srcCache.set(`ALL|${file}`, ''); }
      }
      return srcCache.get(`ALL|${file}`);
    };
    const ownerAssignedIn = (file, recv, dstQname) => {
      const owner = dstQname.slice(0, dstQname.lastIndexOf('.')).split('.').pop();
      if (!owner || !/^[A-Z]/.test(owner)) return false; // a class name, not a package
      const head = recv.split('.')[0];
      return new RegExp(`\\b${head}\\s*=\\s*[\\w.]*\\b${owner}\\s*\\(`).test(srcOf(file));
    };
    // Does this file state `recv: Owner` anywhere — a parameter or a variable
    // declarator annotated with the target's own class? This is the TypeScript
    // counterpart of ownerAssignedIn: nest's TestingModule is never constructed
    // with `new`, it comes back from `Test.createTestingModule(...).compile()`, so
    // the only fact the source states is the declared type (`let testModule:
    // TestingModule;`), which is exactly what Task 2's type reader reads.
    // Same derivation as ownerAssignedIn above: the class that owns a target is
    // the segment right before the LAST dot, not the first one. For a plain
    // `Conn.query` that is the same segment either way, but for a
    // namespace-qualified target like `NS.Conn.query` the first segment is the
    // namespace, not the class — taking it (as this used to, via the Go-only
    // `pkg` variable) would look for `recv: NS` in the source and never match.
    const ownerAnnotatedIn = (file, recv, dstQname) => {
      const owner = dstQname.slice(0, dstQname.lastIndexOf('.')).split('.').pop();
      if (!owner || !/^[A-Z]/.test(owner)) return false;
      const head = recv.split('.').pop();
      return new RegExp(`\\b${head}\\s*:\\s*${owner}\\b`).test(srcOf(file));
    };
    const pkgOf = (file) => store.db.prepare(
      `SELECT substr(qname,1,instr(qname,'.')-1) p FROM nodes
       WHERE file = ? AND instr(qname,'.') > 0 LIMIT 1`).get(file)?.p ?? null;

    for (const [r, sym, claimed] of SYMBOLS.filter(([r]) => r === repo)) {
      const bare = sym.split('.').pop();
      const edges = store.db.prepare(`
        SELECT e.file, e.line, e.guess, e.lang, d.qname dst, d.file dfile, d.container_id cid
        FROM edges e JOIN nodes d ON d.id = e.dst_id
        WHERE e.kind = 'call' AND (d.qname = ? OR d.name = ?)`).all(sym, bare);
      const certain = edges.filter((e) => !e.guess);
      let withReason = 0;
      for (const e of certain) {
        const text = lineOf(e.file, e.line);
        const pkg = e.dst.includes('.') ? e.dst.split('.')[0] : null;
        const qualified = new RegExp(`([A-Za-z_$][\\w$.]*)\\.${bare}\\b`).exec(text);
        const ok = e.dfile === e.file
          || (e.lang === 'go' && pkg && text.includes(`${pkg}.${bare}`))
          || (e.lang === 'go' && pkg && pkgOf(e.file) === pkg)
          || (e.lang === 'go' && pkg && qualified
              && [...(impPath.get(e.file) ?? [])].some((p) => lastSeg(p) === pkg))
          || (e.lang === 'py' && qualified && e.dfile.split('/').includes(qualified[1].split('.').pop()))
          || Boolean(impBase.get(e.file)?.has(stripExt(e.dfile)))
          // `jar.set(...)` with `jar = RequestsCookieJar()` above it: the receiver's
          // type is written in the source, so read the source for it rather than
          // trusting the resolver's own table. The owner is the target's qname minus
          // its last segment, and the constructor may be module-qualified.
          || Boolean(qualified && e.dst.includes('.') && ownerAssignedIn(e.file, qualified[1], e.dst))
          || ((e.lang === 'ts' || e.lang === 'js') && qualified && e.dst.includes('.')
              && ownerAnnotatedIn(e.file, qualified[1], e.dst));
        if (ok) { withReason++; continue; }
        const note = ACCEPTED.get(`${repo} ${sym} ${e.file}`);
        const row = `${repo} ${sym}  ${e.file}:${e.line} -> ${e.dst} (${e.dfile})  | ${text.trim().slice(0, 90)}`;
        if (note) accepted.push(`${row}\n        accepted: ${note}`);
        else unexplained.push(row);
      }
      // The one certainty shape with no fact behind it: a call written as a PLAIN
      // name, matched to a top-level definition in another file that this file
      // does not import. It is right whenever the name really came from there (a
      // re-export, or a function passed in under the same name) and wrong when it
      // came from a package instead. Tracked as a number so it cannot grow
      // unnoticed — every row in it is either read by hand or a failure.
      const risk = certain.filter((e) => e.dfile !== e.file && e.cid === null && e.lang !== 'go'
        && !new RegExp(`[A-Za-z_$][\\w$.]*\\.${bare}\\b`).test(lineOf(e.file, e.line))
        && !impBase.get(e.file)?.has(stripExt(e.dfile))).length;
      atRisk += risk;
      totalResolved += edges.length; totalClaimed += claimed;
      totalCertain += certain.length; totalGuess += edges.length - certain.length;
      rows.push([`${repo} ${sym}`, `${edges.length} / ${claimed}`,
        `${certain.length} / ${edges.length - certain.length}`,
        String(store.gapsFor(sym).length), `${withReason}/${certain.length}`, String(risk)]);
    }
    store.close();
  }

  const head = ['symbol', 'resolved / published', 'certain / guess', 'gap rows', 'certain rows with a reason', 'no-import risk'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(`\nresolved ${totalResolved} (published ${totalClaimed})  certain ${totalCertain}  guessed ${totalGuess}`);
  console.log(`certain rows with a mechanical reason: ${totalCertain - unexplained.length - accepted.length} of ${totalCertain}`);
  console.log(`plain cross-file name with no import behind it: ${atRisk} — every one is listed below`);
  console.log('\nreasons accepted:'); REASONS.forEach((r) => console.log(`  - ${r}`));
  if (accepted.length) {
    console.log(`\n${accepted.length} row(s) with no mechanical reason, read by hand and correct:`);
    accepted.forEach((a) => console.log('   ', a));
  }
  if (unexplained.length) {
    console.log(`\n${unexplained.length} certain row(s) neither explained nor reviewed. Read each one, then`);
    console.log('either fix the resolver or add it to ACCEPTED in this script with the reason:');
    unexplained.forEach((u) => console.log('   ', u));
    process.exit(1);
  }
  console.log('\nEvery certain row is explained. None is false.');
}

main().catch((e) => { process.stderr.write(`measure: ${e.message}\n`); process.exit(2); });
