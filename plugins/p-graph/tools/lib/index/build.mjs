import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { toPosix, isIgnored } from '../config.mjs';
import { resolveLang, SUPPORTED_EXTS } from '../parse/index.mjs';
import { extract } from '../parse/driver.mjs';

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

export async function indexFile(root, store, rel) {
  const cfg = resolveLang(rel);
  if (!cfg) return;
  const source = readFileSync(join(root, rel), 'utf-8');
  const hash = createHash('sha1').update(source).digest('hex');
  const { nodes, edges } = await extract({ file: rel, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
  store.upsertFile(rel, hash, cfg.lang);
  store.replaceFileSymbols(rel, nodes, edges);
}

export async function indexFull({ root, store, ignorePatterns, onError }) {
  store.clear(); // truncate so files deleted since the last index don't survive
  const files = walk(root, root, ignorePatterns, []);
  let skipped = 0;
  for (const rel of files) {
    try {
      await indexFile(root, store, rel);
    } catch (err) {
      skipped++;
      onError?.(rel, err);
    }
  }
  store.resolvePending();
  store.markSchemaCurrent?.(); // a full rebuild brings the DB to the current schema
  return { files: files.length - skipped, skipped };
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
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
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
  for (const rel of change.modified) {
    if (isIgnored(rel, ignorePatterns) || !resolveLang(rel)) continue;
    try {
      await indexFile(root, store, rel); n++;
    } catch (err) {
      skipped++;
      onError?.(rel, err);
    }
  }
  for (const rel of change.deleted) store.removeFile(rel);
  store.resolvePending();
  return { changed: n, deleted: change.deleted.length, skipped };
}
