import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ARM_FILES } from './arms.mjs';

const SKIP_COPY = new Set(['node_modules']);
// .git is copied as evidence but never counted as work: its index and objects
// change on every commit for reasons that have nothing to do with lines written.
// ARM_FILES is what the `docs/tasks` tracker (and any other arm) writes as its
// own bookkeeping — counting that as churn would measure the file format the
// arm happens to use, not the work the agent did, and only one arm would ever
// pay the price.
const SKIP_COUNT = new Set(['node_modules', '.git', ...ARM_FILES]);
// An allowlist, not a sniff: a file this list misses counts as zero lines, in
// both the numerator and the denominator of the churn ratio, so a miss shrinks
// what is measured rather than skewing it. The polygon is plain JavaScript, but
// an agent may reach for a neighbouring file type, and a file it wrote that
// nothing counts is work the study cannot see.
const TEXT = /\.(m?[jt]sx?|cjs|cts|json|md|ya?ml|txt|ini|css|html?|sh)$/i;

// A file that ends with a newline splits into a trailing empty string. That is
// not a line anybody wrote, and counting it would make every new file one line
// longer than it is. Drop that one element and nothing else: a blank line in
// the middle IS a line somebody wrote, and dropping every empty string would
// hide the churn of adding and removing them.
//
// Split on `\r?\n`, not plain `\n`: the study runs on Windows, and a file
// rewritten with CRLF line endings must not look like every line changed
// against an LF predecessor that says the same thing.
const lines = (text) => {
  const out = text.split(/\r?\n/);
  if (out.at(-1) === '') out.pop();
  return out;
};

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
      const p = join(d, e.name);
      // Checked two ways: `node_modules` and `.git` are bare names that can
      // recur at any depth, but an arm's own path (`docs/tasks`) is only ever
      // one exact place from the tree's root, so it has to be matched against
      // the path relative to that root, not against the last segment alone.
      const rel = relative(dir, p).split(sep).join('/');
      if (SKIP_COUNT.has(e.name) || SKIP_COUNT.has(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name) && statSync(p).size < 1_000_000) {
        out.set(rel, lines(readFileSync(p, 'utf-8')));
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
