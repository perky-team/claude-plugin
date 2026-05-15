// Wraps bare <word>-style tokens in backticks so Obsidian / CommonMark don't
// parse them as HTML tag opens. A "bare" token is one not already inside an
// inline-code span or a fenced code block.
//
// Token pattern: < then ASCII letter, then [a-zA-Z0-9_-]*, then >.

const TOKEN_RE = /<[a-zA-Z][a-zA-Z0-9_-]*>/g;

function findProtectedRanges(text) {
  const ranges = [];
  // Fenced code blocks ``` ... ```
  const fenceRe = /```[\s\S]*?```/g;
  for (const m of text.matchAll(fenceRe)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline code `...` (no newline, no nested backtick)
  const inlineRe = /`[^`\n]+`/g;
  for (const m of text.matchAll(inlineRe)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInside(idx, ranges) {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

export function sanitize(text) {
  const protectedRanges = findProtectedRanges(text);
  return text.replace(TOKEN_RE, (match, offset) => {
    if (isInside(offset, protectedRanges)) return match;
    return '`' + match + '`';
  });
}
