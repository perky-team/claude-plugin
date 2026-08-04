import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { toPosix, isIgnored } from '../config.mjs';
import { resolveLang, SUPPORTED_EXTS } from '../parse/index.mjs';
import { extract } from '../parse/driver.mjs';

// `stdio` drops git's own stderr instead of piping it: in a non-git tree (or
// any other git failure) every one of these calls fails, and git's own
// "fatal: not a git repository" line would otherwise print straight to this
// process's real stderr — not just returned on the caught error, but visible
// on the terminal (and in the test output) even though the failure is always
// caught and handled here. p-graph's own STALE banner already says what the
// user needs; git's raw complaint underneath it is noise.
const GIT_STDIO = ['ignore', 'pipe', 'ignore'];

export function headSha(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8', stdio: GIT_STDIO }).trim();
  } catch { return null; }
}

function walk(root, dir, ignorePatterns, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = toPosix(relative(root, abs));
    if (isIgnored(rel, ignorePatterns)) continue;
    if (entry.isDirectory()) walk(root, abs, ignorePatterns, acc);
    else if (SUPPORTED_EXTS.includes(`.${entry.name.split('.').pop()?.toLowerCase()}`)) acc.push(rel);
  }
  return acc;
}

// Every Python module path this repo can import, and the module path each .py
// file provides. Returned as `{ paths, byFile }` and handed to the parser, which
// needs it to tell a module-qualified call (`requests.get(...)`) from a call on
// something we do not index (`json.dumps(...)`, the standard library).
//
// A source root is the repo root plus any directory that HOLDS a package and is
// not itself one (no `__init__.py`). That is the part a simpler check gets wrong
// in both directions:
//   - looking for `<root>/requests.py` refuses requests entirely, because the
//     package lives at `src/requests/__init__.py`;
//   - matching the bare directory name accepts flask's `json`, because
//     `src/flask/json/__init__.py` exists — and then `import json` plus
//     `json.dumps()` links to flask's own `dumps`.
// Counting from the source root gives `requests` and `flask.json`, so the first
// resolves and the second never answers for the standard library.
export function pyModuleIndex(files) {
  const pyFiles = files.filter((f) => f.endsWith('.py'));
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const packages = new Set();
  for (const f of pyFiles) {
    if (f === '__init__.py' || f.endsWith('/__init__.py')) packages.add(dirOf(f));
  }
  const roots = new Set(['']);
  for (const p of packages) if (!packages.has(dirOf(p))) roots.add(dirOf(p));
  // Longest root first: a file under `src/` is `requests.utils`, not
  // `src.requests.utils`.
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  const byFile = new Map();
  for (const f of pyFiles) {
    const root = sorted.find((r) => r === '' || f.startsWith(`${r}/`));
    if (root === undefined) continue;
    let rel = (root === '' ? f : f.slice(root.length + 1)).slice(0, -'.py'.length);
    // A source root that is itself a package has no importable name of its own.
    if (rel === '__init__') continue;
    if (rel.endsWith('/__init__')) rel = rel.slice(0, -'/__init__'.length);
    byFile.set(f, rel.split('/').join('.'));
  }
  return { paths: new Set(byFile.values()), byFile };
}

// Parse and store one file. Returns the number of nodes indexed (>= 0), or
// `null` when the file is unsupported or unchanged since the last index (so a
// caller can tell "indexed, produced nothing" from "not indexed at all").
export async function indexFile(root, store, rel, pyRepoModules = null) {
  const cfg = resolveLang(rel);
  if (!cfg) return null;
  const source = readFileSync(join(root, rel), 'utf-8');
  const hash = createHash('sha1').update(source).digest('hex');
  // Skip files whose content is unchanged since the last index. `indexFull`
  // calls store.clear() first (files table truncated), so fileHash is null there
  // and every file is fully parsed; only incremental runs skip.
  if (store.fileHash?.(rel) === hash) return null;
  const { nodes, edges, fieldTypes } = await extract({
    file: rel, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source, pyRepoModules });
  store.upsertFile(rel, hash, cfg.lang);
  store.replaceFileSymbols(rel, nodes, edges, fieldTypes);
  return nodes.length;
}

export async function indexFull({ root, store, ignorePatterns, onError }) {
  store.clear(); // truncate so files deleted since the last index don't survive
  const files = walk(root, root, ignorePatterns, []);
  let skipped = 0;
  // `errored`: files whose parse/store threw (dropped from the graph entirely).
  // `zeroNode`: files that indexed cleanly but produced no symbols — a legit
  // empty file, or a whole-file extraction gap worth surfacing (see index cmd).
  const errored = [];
  const zeroNode = [];
  const pyRepoModules = pyModuleIndex(files);
  for (const rel of files) {
    try {
      const nodeCount = await indexFile(root, store, rel, pyRepoModules);
      if (nodeCount === 0) zeroNode.push(rel);
    } catch (err) {
      skipped++;
      errored.push({ file: rel, error: String(err?.message ?? err) });
      onError?.(rel, err);
    }
  }
  store.resolvePending();
  store.markSchemaCurrent?.(); // a full rebuild brings the DB to the current schema
  return { files: files.length - skipped, skipped, errored, zeroNode };
}

// Pure parser — testable without a real repo.
export function parseGitChanges(diffText, porcelainText) {
  const modified = new Set(), deleted = new Set();
  for (const line of (diffText ?? '').split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0][0];
    if (status === 'R' || status === 'C') { deleted.add(toPosix(parts[1])); modified.add(toPosix(parts[2])); }
    else if (status === 'D') deleted.add(toPosix(parts[1]));
    else modified.add(toPosix(parts[1]));
  }
  for (const line of (porcelainText ?? '').split('\n').filter(Boolean)) {
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    if (rest.includes(' -> ')) { const [o, n] = rest.split(' -> '); deleted.add(toPosix(o)); modified.add(toPosix(n)); }
    else if (status.includes('D')) deleted.add(toPosix(rest));
    else modified.add(toPosix(rest));
  }
  return { modified: [...modified], deleted: [...deleted].filter((p) => !modified.has(p)) };
}

export function gitChangedFiles(root, indexedSha) {
  const run = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: GIT_STDIO }).trimEnd();
  try {
    const diffText = indexedSha ? run(['diff', '--name-status', `${indexedSha}..HEAD`]) : '';
    const porcelainText = run(['status', '--porcelain']);
    return parseGitChanges(diffText, porcelainText);
  } catch { return null; }
}

export async function indexChanged({ root, store, ignorePatterns, changedFiles, onError }) {
  // A schema bump changed the on-disk symbol format (e.g. qname qualification),
  // so incrementally patching a stale DB would mix old and new shapes. Rebuild.
  if (store.schemaStale?.()) {
    return indexFull({ root, store, ignorePatterns, onError });
  }
  // No explicit change list and no prior full index: there's no git-diff baseline,
  // so `git status --porcelain` alone sees only dirty working-tree files and would
  // silently skip the entire committed codebase. Bootstrap with a full index.
  if (!changedFiles && !store.getMeta('indexed_sha')) {
    return indexFull({ root, store, ignorePatterns, onError });
  }
  const provider = changedFiles ?? (() => gitChangedFiles(root, store.getMeta('indexed_sha')));
  const change = provider();
  if (!change) return indexFull({ root, store, ignorePatterns, onError });
  let n = 0, skipped = 0;
  const errored = [];
  const zeroNode = [];
  // The Python module list is repo-wide, so it cannot be built from the changed
  // files alone: the already-indexed files are what say where the packages are.
  // Take them from the files table and add this run's changes on top.
  const known = store.db
    ? store.db.prepare(`SELECT path FROM files WHERE lang = 'py'`).all().map((r) => r.path)
    : [];
  const deleted = new Set(change.deleted);
  const pyRepoModules = pyModuleIndex([...new Set([...known, ...change.modified])]
    .filter((p) => !deleted.has(p)));
  for (const rel of change.modified) {
    if (isIgnored(rel, ignorePatterns) || !resolveLang(rel)) continue;
    try {
      const nodeCount = await indexFile(root, store, rel, pyRepoModules);
      if (nodeCount !== null) n++;
      if (nodeCount === 0) zeroNode.push(rel);
    } catch (err) {
      skipped++;
      errored.push({ file: rel, error: String(err?.message ?? err) });
      onError?.(rel, err);
    }
  }
  for (const rel of change.deleted) store.removeFile(rel);
  // Edge resolution only changes when nodes are added or removed. If nothing was
  // reparsed and nothing was deleted, the resolution state is already correct, so
  // skip the (full-table) resolvePending scan — this keeps repeat queries over a
  // stable dirty tree cheap.
  if (n > 0 || change.deleted.length > 0) store.resolvePending();
  return { changed: n, deleted: change.deleted.length, skipped, errored, zeroNode };
}
