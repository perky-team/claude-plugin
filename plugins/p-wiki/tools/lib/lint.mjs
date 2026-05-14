import { validateFrontmatter } from './schema.mjs';
import { dirname, join } from 'node:path';

const TYPE_FOR_DIR = {
  'pages/concept': 'concept',
  'pages/person': 'person',
  'pages/source': 'source',
  'pages/queries': 'query',
};

const linkRe = /\[[^\]]*\]\(([^)#\s]+)\)/g;

export function runChecks(docs, { repoRoot, existsFn }) {
  const errors = { 'dead-links': [], 'dead-sources': [], 'frontmatter': [] };
  const warnings = { 'orphan-pages': [], 'underlinked': [], 'stale': [] };

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
