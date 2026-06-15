import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PGRAPH_DIR = '.pgraph';
export const CONFIG_REL = '.pgraph/config.json';
export const IGNORE_REL = '.pgraph/.pgraphignore';

export const DEFAULT_IGNORES = [
  '.git', '.pgraph', 'node_modules', 'vendor', 'third_party',
  'dist', 'build', 'out',
];

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

// Directory- or prefix-segment match against POSIX path. Patterns match any path
// segment (so "node_modules" matches "a/node_modules/b") or a literal prefix.
export function isIgnored(relPath, extraPatterns = []) {
  const path = toPosix(relPath);
  const segs = path.split('/');
  const pats = [...DEFAULT_IGNORES, ...extraPatterns];
  for (const pat of pats) {
    if (pat.endsWith('.min.js') && path.endsWith('.min.js')) return true;
    if (segs.includes(pat)) return true;
    if (path === pat || path.startsWith(pat + '/')) return true;
  }
  return path.endsWith('.min.js');
}
