import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_COPY = new Set(['node_modules']);
// .git is copied as evidence but never counted as work: its index and objects
// change on every commit for reasons that have nothing to do with lines written.
const SKIP_COUNT = new Set(['node_modules', '.git']);
const TEXT = /\.(js|mjs|cjs|json|md|ya?ml|txt|ini)$/i;

/** Copy a working tree. Returns the destination. */
export function snapshot(srcDir, destDir) {
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => !src.split(sep).some((part) => SKIP_COPY.has(part)),
  });
  return destDir;
}

function textFiles(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_COUNT.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name) && statSync(p).size < 1_000_000) {
        out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf-8').split('\n').filter(Boolean));
      }
    }
  };
  walk(dir);
  return out;
}

// Changed lines without a real diff library: strip the common head and tail,
// and call what is left changed. It over-counts a pure insertion in the middle
// and never under-counts, which is what a churn ratio needs.
function changed(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
         && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return Math.max(a.length, b.length) - head - tail;
}

/** Lines that differ between two trees. */
export function changedLines(dirA, dirB) {
  const a = textFiles(dirA);
  const b = textFiles(dirB);
  let total = 0;
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    total += changed(a.get(path), b.get(path));
  }
  return total;
}
