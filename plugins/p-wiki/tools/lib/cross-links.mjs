// plugins/p-wiki/tools/lib/cross-links.mjs

// Standard markdown inline-link: [text](href). The text portion may include
// escaped characters but no unescaped ']' or '\n'; the href may not contain
// unescaped ')' or '\n'. Shortcut/reference forms ([text][id], [text])
// are skipped via the range logic below.
const LINK_RE = /\[([^\]\n]+?)\]\(([^)\n]+?)\)/g;

function findSkippedRanges(body) {
  const raw = [];
  // Fenced code blocks
  for (const m of body.matchAll(/```[\s\S]*?```/g)) raw.push([m.index, m.index + m[0].length]);
  // Inline code
  for (const m of body.matchAll(/`[^`\n]+`/g)) raw.push([m.index, m.index + m[0].length]);
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

function walkLinks(body, fn) {
  const skipped = findSkippedRanges(body);
  let out = '';
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(body)) !== null) {
    if (isInside(m.index, skipped)) continue;
    const [whole, text, href] = m;
    const replacement = fn({ text, href });
    if (replacement !== undefined) {
      out += body.slice(last, m.index) + replacement;
      last = m.index + whole.length;
    }
  }
  out += body.slice(last);
  return out;
}

export function rewriteCrossLinks(body, src, srcPath, dst, dstPath, opts = {}) {
  const onWarn = opts.onWarn ?? (() => {});
  return walkLinks(body, ({ text, href }) => {
    const id = src.parseWikiLink(href, srcPath);
    if (id === null) return undefined;                  // pass through verbatim
    try {
      const newHref = dst.formatWikiLink(id, dstPath);
      return `[${text}](${newHref})`;
    } catch (e) {
      onWarn({ type: id.type, slug: id.slug, error: e });
      return undefined;                                  // pass through verbatim
    }
  });
}

export function stripCrossLinks(body, src, srcPath) {
  return walkLinks(body, ({ text, href }) => {
    const id = src.parseWikiLink(href, srcPath);
    if (id === null) return undefined;
    return `[${text}](#pwiki-pending)`;
  });
}
