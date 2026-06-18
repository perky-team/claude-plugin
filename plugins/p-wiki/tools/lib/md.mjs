// Wraps bare <word>-style tokens in backticks so Obsidian / CommonMark don't
// parse them as HTML tag opens. A "bare" token is one not already inside an
// inline-code span or a fenced code block.
//
// Token pattern: < then ASCII letter, then [a-zA-Z0-9_-]*, then >.

const TOKEN_RE = /<[a-zA-Z][a-zA-Z0-9_-]*>/g;

// Matches CommonMark-style inline code spans with variable-length backtick
// fences: a run of N backticks opens the span, and the same run of N backticks
// closes it. This correctly handles double-backtick spans that contain interior
// single backticks (e.g. ``a ` b``), unlike the naive /`[^`\n]+`/g regex.
//
// The `s` flag makes `.` match newlines so multi-line inline spans (permitted
// by CommonMark for single-backtick fences) are also captured correctly.
// Cross-newline pairing (backtick fence opened on one line, closed on another)
// is intentional: CommonMark allows it for any fence length, not just single
// backticks, and dotall is the correct way to honour that without a lookahead
// that would reject valid spans.
const INLINE_CODE_RE = /(`+)(?:(?!\1).)*?\1/gs;

/**
 * Returns an array of [start, end) offset pairs covering every inline-code
 * span in `text`. Uses variable-length backtick-fence matching so spans
 * delimited by `` `` `` or longer fences are handled correctly.
 *
 * Exported so cross-links.mjs, backlinks.mjs, lint.mjs, and md.mjs itself
 * share a single canonical implementation.
 *
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
export function inlineCodeRanges(text) {
  const ranges = [];
  const re = new RegExp(INLINE_CODE_RE.source, INLINE_CODE_RE.flags);
  for (const m of text.matchAll(re)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function findProtectedRanges(text) {
  const ranges = [];
  // Fenced code blocks ``` ... ```
  const fenceRe = /```[\s\S]*?```/g;
  for (const m of text.matchAll(fenceRe)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline code spans (variable-length fence, handles ``double-backtick`` spans)
  for (const r of inlineCodeRanges(text)) {
    ranges.push(r);
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
