import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function findRepoRoot(start = process.cwd()) {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
