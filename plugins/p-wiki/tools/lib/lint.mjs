import { validateFrontmatter } from './schema.mjs';
import { dirname, join } from 'node:path';

const TYPE_FOR_DIR = {
  'pages/concept': 'concept',
  'pages/person': 'person',
  'pages/source': 'source',
  'pages/queries': 'query',
};

const linkRe = /\[[^\]]*\]\(([^)#\s]+)\)/g;

// A body conflict callout: any blockquote line mentioning "conflict" or
// "superseded" — covers the `> ⚠️ …`, `> **Superseded …**`, and
// `> **Note:** … superseded …` shapes. The whole line is captured so the
// optional date — "(since YYYY-MM-DD)" or "(YYYY-MM-DD)" — can be read.
const CONFLICT_MARKER = /^[ \t]*>.*\b(?:conflict|superseded)\b.*$/im;
const MARKER_DATE = /\((?:since\s+)?(\d{4}-\d{2}-\d{2})\)/i;

// ADR / decision pages keep a "superseded by …" notice permanently by
// convention (immutable record pointing to its successor) — they are not
// reconcile targets, so they are excluded from the conflicts bucket.
function isDecisionPage(d) {
  const name = (d.path ?? '').split('/').pop() ?? '';
  const id = String(d.frontmatter?.id ?? '');
  const title = String(d.frontmatter?.title ?? '');
  return /^adr-?\d/i.test(name) || /^adr-?\d/i.test(id) || /^adr-?\d/i.test(title);
}

// Reference / volatile sources: appear in sources: but are not a page's
// *defining* source — a glossary tweak or a per-commit changelog bump should
// not flag every page that merely cites them. Matched on basename, ignoring an
// optional NN- numeric prefix and the extension.
const REFERENCE_SOURCE = /^(?:\d+[-_. ])?(?:changelog|glossary|readme|contributing|license)s?\b/i;

export function runChecks(docs, { repoRoot, existsFn, sourceDateFn }) {
  const errors = { 'dead-links': [], 'dead-sources': [], 'frontmatter': [] };
  const warnings = { 'orphan-pages': [], 'underlinked': [], 'stale': [], 'conflicts': [], 'source-changed': [] };

  const suppressed = { 'source-changed': { count: 0, _sources: new Set() } };

  const allPaths = new Set(docs.map(d => d.path));
  const todayStr = new Date().toISOString().slice(0, 10);

  // Build outgoing link graph (page → page targets)
  const outgoing = new Map();
  for (const d of docs) {
    const targets = [];
    let m;
    const re = new RegExp(linkRe);
    while ((m = re.exec(d.body))) {
      const link = m[1];
      const resolved = resolveLink(d.path, link);
      targets.push({ link, resolved });
    }
    outgoing.set(d.path, targets);
  }

  for (const d of docs) {
    // dead-links
    for (const t of outgoing.get(d.path)) {
      if (!existsFn(join(repoRoot, t.resolved))) {
        errors['dead-links'].push({ file: d.path, link: t.link, target: t.resolved });
      }
    }
    // dead-sources
    for (const s of d.frontmatter.sources ?? []) {
      if (!existsFn(join(repoRoot, s))) {
        errors['dead-sources'].push({ file: d.path, source: s });
      }
    }
    // frontmatter validity
    const v = validateFrontmatter(d.frontmatter);
    if (!v.ok) errors.frontmatter.push({ file: d.path, error: v.error });
    // type-directory mismatch
    const dir = Object.keys(TYPE_FOR_DIR).find(k => d.path.includes(`docs/wiki/${k}/`));
    if (dir) {
      const expected = TYPE_FOR_DIR[dir];
      if (d.frontmatter.type !== expected && !d.path.includes('docs/wiki/raw/')) {
        errors.frontmatter.push({ file: d.path, expected, actual: d.frontmatter.type });
      }
    }
    // underlinked: concept pages, status != draft, < 3 outgoing
    if (d.frontmatter.type === 'concept' && d.frontmatter.status !== 'draft') {
      const cnt = (outgoing.get(d.path) ?? []).length;
      if (cnt < 3) warnings.underlinked.push({ file: d.path, count: cnt });
    }
    // stale: status: active, updated older than 90 days
    if (d.frontmatter.status === 'active' && d.frontmatter.updated) {
      const days = daysBetween(d.frontmatter.updated, todayStr);
      if (days > 90) warnings.stale.push({ file: d.path, updated: d.frontmatter.updated, days });
    }
    // conflicts: page carries an unresolved conflict — either a frontmatter
    // flag, or a body callout (catches legacy callouts written before the flag
    // existed). Age from the flag, else the marker's "(since …)" date, else null.
    const flag = d.frontmatter['conflict-since'] ?? null;
    const calloutLine = (d.body ?? '').match(CONFLICT_MARKER)?.[0] ?? null;
    if ((flag || calloutLine) && !isDecisionPage(d)) {
      const markerDate = calloutLine?.match(MARKER_DATE)?.[1] ?? null;
      const since = flag ?? markerDate;
      warnings.conflicts.push({
        file: d.path,
        since,
        days: since ? daysBetween(since, todayStr) : null,
      });
    }
    // source-changed: a source was committed after the page was last (re)compiled.
    // Needs source commit dates, which runChecks can't compute purely — injected like existsFn.
    if (sourceDateFn) {
      const pageUpdated = d.frontmatter.updated;
      for (const s of d.frontmatter.sources ?? []) {
        const sourceDate = sourceDateFn(s);
        const isStale = sourceDate && pageUpdated && sourceDate > pageUpdated;
        if (!isStale) continue;
        const base = s.split(/[\\/]/).pop() ?? s;
        if (REFERENCE_SOURCE.test(base)) {
          // Would have warned, but it's a reference/volatile source — suppress and count.
          suppressed['source-changed'].count++;
          suppressed['source-changed']._sources.add(s);
          continue;
        }
        warnings['source-changed'].push({ file: d.path, source: s, sourceDate, pageUpdated });
      }
    }
  }

  // orphan-pages: not index.md, not queries/, no incoming links
  const incoming = new Map();
  for (const [src, targets] of outgoing.entries()) {
    for (const t of targets) {
      if (!incoming.has(t.resolved)) incoming.set(t.resolved, []);
      incoming.get(t.resolved).push(src);
    }
  }
  for (const d of docs) {
    if (d.path.endsWith('/index.md')) continue;
    if (d.path.includes('/pages/queries/')) continue;
    // Raw pages live in sources: arrays of other pages, not as link targets in bodies.
    if (d.path.includes('/raw/')) continue;
    if ((incoming.get(d.path) ?? []).length === 0) {
      warnings['orphan-pages'].push({ file: d.path });
    }
  }

  return {
    errors,
    warnings,
    totals: {
      errors: Object.values(errors).reduce((a, b) => a + b.length, 0),
      warnings: Object.values(warnings).reduce((a, b) => a + b.length, 0),
    },
    suppressed: {
      'source-changed': {
        count: suppressed['source-changed'].count,
        sources: [...suppressed['source-changed']._sources].sort(),
      },
    },
  };
}

function resolveLink(fromPath, link) {
  if (link.startsWith('/')) return link.slice(1);
  return join(dirname(fromPath), link).split(/[\\/]/).join('/');
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
