import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PGRAPH_DIR = '.pgraph';
export const CONFIG_REL = '.pgraph/config.json';
export const IGNORE_REL = '.pgraph/.pgraphignore';

// Matched against any path segment — safe to skip wherever they appear
// (node_modules is legitimately nested in monorepos).
export const IGNORE_ANYWHERE = ['.git', '.pgraph', 'node_modules'];
// Matched only as a root-level prefix — these names (build/, out/, dist/, …)
// are common as real source directories deeper in a tree, so segment-matching
// them would silently drop legitimate files like src/build/api.ts.
export const IGNORE_ROOT = ['vendor', 'third_party', 'dist', 'build', 'out'];

// Back-compat: the union of both default lists.
export const DEFAULT_IGNORES = [...IGNORE_ANYWHERE, ...IGNORE_ROOT];

export function toPosix(p) { return p.replace(/\\/g, '/'); }

export function defaultConfig() { return { destination: 'local' }; }

export function configPath(root) { return join(root, CONFIG_REL); }

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function readIgnorePatterns(root) {
  const p = join(root, IGNORE_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Match against a POSIX path. `IGNORE_ANYWHERE` matches any path segment (so
// "node_modules" matches "a/node_modules/b"); `IGNORE_ROOT` matches only as a
// root-level prefix. Caller-supplied `extraPatterns` match either way (segment
// or literal prefix) so a .pgraphignore line like "src/legacy" still works.
export function isIgnored(relPath, extraPatterns = []) {
  const path = toPosix(relPath);
  if (path.endsWith('.min.js')) return true;
  const segs = path.split('/');
  for (const pat of IGNORE_ANYWHERE) {
    if (segs.includes(pat)) return true;
  }
  for (const pat of [...IGNORE_ROOT, ...extraPatterns]) {
    if (path === pat || path.startsWith(pat + '/')) return true;
  }
  for (const pat of extraPatterns) {
    if (segs.includes(pat)) return true;
  }
  return false;
}
