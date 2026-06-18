import { posix as pathPosix } from 'node:path';
import { inlineCodeRanges } from './md.mjs';

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns sorted, non-overlapping array of [start, end) offset pairs.
export function findSkippedRanges(body) {
  const raw = [];
  // Fenced code blocks ``` ... ```
  for (const m of body.matchAll(/```[\s\S]*?```/g)) {
    raw.push([m.index, m.index + m[0].length]);
  }
  // Inline code spans (variable-length fence, handles ``double-backtick`` spans)
  for (const r of inlineCodeRanges(body)) {
    raw.push(r);
  }
  // Any [..] bracket form. Covers [text](url), [text][id], and bare [text]
  // shortcut references. We intentionally over-skip rather than
  // implement full CommonMark link parsing: the optional trailing
  // (...) or [...] group is included so matches inside the URL /
  // reference id are also skipped.
  for (const m of body.matchAll(/\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])?/g)) {
    raw.push([m.index, m.index + m[0].length]);
  }
  // Sort and merge overlaps
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of raw) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function isInside(idx, ranges) {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

function offsetToLineCol(body, offset) {
  // 1-based line and column
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (body.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

export function findFirstMatch(body, title) {
  if (!title) return null;
  const escaped = escapeRegex(title);
  // Unicode word-boundary: not preceded/followed by letter or digit.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  const skipped = findSkippedRanges(body);
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!isInside(m.index, skipped)) {
      const { line, col } = offsetToLineCol(body, m.index);
      return { index: m.index, length: title.length, line, col };
    }
  }
  return null;
}

export function insertLinkAt(body, match, replacement) {
  return body.slice(0, match.index) + replacement + body.slice(match.index + match.length);
}

export function computeRelPath(fromRepoRel, toRepoRel) {
  const fromDir = pathPosix.dirname(fromRepoRel);
  return pathPosix.relative(fromDir, toRepoRel);
}
