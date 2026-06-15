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
  return { files: files.length - skipped, skipped };
}

export function gitChangedFiles(root, indexedSha) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  let modified = [], deleted = [];
  try {
    const range = indexedSha ? `${indexedSha}..HEAD` : null;
    const diff = range ? run(['diff', '--name-status', range]) : '';
    const porcelain = run(['status', '--porcelain']);
    const lines = [...diff.split('\n'), ...porcelain.split('\n')].filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z?]+)\s+(.+)$/);
      if (!m) continue;
      const [, status, path] = m;
      (status.startsWith('D') ? deleted : modified).push(toPosix(path));
    }
  } catch { return null; }
  return { modified: [...new Set(modified)], deleted: [...new Set(deleted)] };
}

export async function indexChanged({ root, store, ignorePatterns, changedFiles, onError }) {
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
