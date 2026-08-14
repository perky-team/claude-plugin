// R39 — diff two resolved values. R40 — print a diff.
import { joinPath } from './paths.js';

function flatten(value) {
  const out = {};
  for (const [section, keys] of Object.entries(value)) {
    for (const [key, v] of Object.entries(keys)) out[joinPath(section, key)] = v;
  }
  return out;
}

export function diffResolved(a, b) {
  const flatA = flatten(a);
  const flatB = flatten(b);
  const paths = new Set([...Object.keys(flatA), ...Object.keys(flatB)]);

  const diffs = [];
  for (const path of paths) {
    const before = flatA[path];
    const after = flatB[path];
    if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push({ path, before, after });
  }
  diffs.sort((x, y) => (x.path === y.path ? 0 : x.path < y.path ? -1 : 1));
  return diffs;
}

export function formatDiff(diffs) {
  // Template-literal coercion already turns a missing side's `undefined`
  // into the literal text `undefined`.
  return diffs.map((d) => `${d.path}: ${d.before} -> ${d.after}`).join('\n');
}
