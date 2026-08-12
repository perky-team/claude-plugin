#!/usr/bin/env node
// What p-graph costs to keep, and how well it fits a repo.
//
//   node plugins/p-graph/scripts/measure-cost.mjs
//   node plugins/p-graph/scripts/measure-cost.mjs --repos hugo,nest
//   node plugins/p-graph/scripts/measure-cost.mjs --work /path
//
// It reuses the clones `measure.mjs` makes, so run that first. `measure.mjs`
// answers "is the answer right". This one answers the two questions that come
// before it: what do I pay to keep the graph, and will it say anything useful
// about MY repo.
//
// Every number is printed per repo, and nothing here can fail the run — it is a
// report, not an alarm.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'tools', 'pgraph.mjs');
const STORE_URL = new URL('../tools/lib/destinations/local-sqlite.mjs', import.meta.url);

// Extensions pgraph parses. Kept as a literal list on purpose: this script asks
// "what share of the repo can the graph see", and that question needs the
// shipped answer, not one derived from the same table the parser uses.
const SUPPORTED = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.py', '.cpp', '.cc', '.cxx', '.h', '.hpp',
]);

// One symbol per repo, used only to time a query against a text search. Picked
// for a middling answer size — a one-row answer times the process start, not the
// lookup.
const TIMED = {
  hugo: ['helpers.Exists', 'Exists'],
  caddy: ['caddy.ParseDuration', 'ParseDuration'],
  nest: ['isObject', 'isObject'],
  flask: ['url_for', 'url_for'],
  requests: ['get', 'get'],
  got: ['setHeader', 'setHeader'],
  leveldb: ['TotalFileSize', 'TotalFileSize'],
};

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const work = String(flag('work', join(tmpdir(), 'pgraph-measure')));
const only = flag('repos') && String(flag('repos')).split(',').map((s) => s.trim());
const repos = Object.keys(TIMED).filter((r) => !only || only.includes(r));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8', maxBuffer: 1 << 28 });
const pgraph = (cwd, ...a) => execFileSync('node', [CLI, ...a], { cwd, encoding: 'utf-8', maxBuffer: 1 << 28 });

const ms = (fn) => { const t0 = Date.now(); fn(); return Date.now() - t0; };
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mb = (bytes) => bytes / 1024 / 1024;
const size = (p) => (existsSync(p) ? statSync(p).size : 0);

// Time the same work three times and keep the middle one. A single run on
// Windows is dominated by whatever the filesystem cache happened to hold.
const median3 = (fn) => median([ms(fn), ms(fn), ms(fn)]);

// The biggest source file the graph indexes — the worst realistic single-file
// edit, so the incremental number is a ceiling and not a best case.
function biggestSourceFile(dir, tracked) {
  let best = null; let bestSize = -1;
  for (const rel of tracked) {
    if (!SUPPORTED.has(extname(rel).toLowerCase())) continue;
    const s = size(join(dir, rel));
    if (s > bestSize) { bestSize = s; best = rel; }
  }
  return best;
}

async function main() {
  const { openStore } = await import(STORE_URL);
  const fit = []; const cost = [];

  for (const repo of repos) {
    const dir = join(work, repo);
    if (!existsSync(join(dir, '.git'))) {
      process.stderr.write(`  skip ${repo}: no clone in ${work} — run measure.mjs first\n`);
      continue;
    }
    process.stderr.write(`${repo}:\n`);

    const tracked = git(dir, 'ls-files').split('\n').filter(Boolean);
    const supported = tracked.filter((f) => SUPPORTED.has(extname(f).toLowerCase()));

    // --- cost: a full index from nothing ---
    const fullMs = ms(() => pgraph(dir, 'index', '--full'));
    const db = join(dir, '.pgraph', 'graph.db');
    const dbBytes = size(db) + size(`${db}-wal`) + size(`${db}-shm`);

    // --- cost: one file edited, then an incremental index ---
    const victim = biggestSourceFile(dir, tracked);
    let changedMs = null;
    if (victim) {
      const comment = extname(victim) === '.py' ? '\n# pgraph measurement\n' : '\n// pgraph measurement\n';
      appendFileSync(join(dir, victim), comment);
      changedMs = ms(() => pgraph(dir, 'index', '--changed'));
      git(dir, 'checkout', '--', victim);
    }

    // --- cost: one query, against the text search a person would run instead ---
    const [qname, bare] = TIMED[repo];
    const queryMs = median3(() => pgraph(dir, 'callers', qname, '--stale-ok', '--json'));
    const grepMs = median3(() => {
      try { git(dir, 'grep', '-n', '-E', `\\b${bare}\\s*\\(`); } catch { /* no hits exits 1 */ }
    });

    // --- fit: what the graph can say about this repo ---
    const store = openStore(db);
    const st = store.status();
    const row = store.db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN dst_id IS NOT NULL AND guess = 0 THEN 1 ELSE 0 END) certain,
             SUM(CASE WHEN dst_id IS NOT NULL AND guess = 1 THEN 1 ELSE 0 END) guessed
      FROM edges WHERE kind = 'call'`).get();
    store.close();

    const resolved = row.certain + row.guessed;
    fit.push([
      repo,
      `${supported.length}/${tracked.length}`,
      `${((supported.length / tracked.length) * 100).toFixed(0)}%`,
      String(st.files),
      String(row.total),
      `${((resolved / row.total) * 100).toFixed(0)}%`,
      `${((row.certain / Math.max(resolved, 1)) * 100).toFixed(0)}%`,
    ]);
    cost.push([
      repo,
      String(st.files),
      `${(fullMs / 1000).toFixed(1)} s`,
      `${mb(dbBytes).toFixed(1)} MB`,
      `${(mb(dbBytes) / (st.files / 1000)).toFixed(1)} MB`,
      changedMs === null ? '-' : `${(changedMs / 1000).toFixed(1)} s`,
      `${queryMs} ms`,
      `${grepMs} ms`,
    ]);
  }

  const table = (head, rows) => {
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
    console.log(line(head));
    console.log(w.map((n) => '-'.repeat(n)).join('  '));
    rows.forEach((r) => console.log(line(r)));
  };

  console.log('\n== will it fit my repo ==\n');
  table(['repo', 'source files / tracked', 'share', 'indexed', 'call sites', 'attributed', 'certain of those'], fit);

  console.log('\n== what it costs to keep ==\n');
  table(['repo', 'files', 'full index', 'db', 'db per 1k files', 'index after 1 edit', 'one query', 'git grep'], cost);
  console.log('\n"attributed" is call sites the graph linked to a repo symbol; the rest are');
  console.log('stdlib, third party, or a call it could not place — all reported, never hidden.');
}

main().catch((e) => { process.stderr.write(`measure-cost: ${e.message}\n`); process.exit(2); });
