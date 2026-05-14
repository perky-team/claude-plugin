import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export function findWikiRoot(startDir) {
  let cur = startDir;
  while (true) {
    if (existsSync(join(cur, 'docs', 'wiki', 'CLAUDE.md'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function toRepoRelative(repoRoot, absPath) {
  return relative(repoRoot, absPath).split(sep).join('/');
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
