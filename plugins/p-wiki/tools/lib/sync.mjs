// plugins/p-wiki/tools/lib/sync.mjs
import { rewriteCrossLinks, stripCrossLinks } from './cross-links.mjs';

export async function syncToMirror(src, dst, opts = {}) {
  const mirrorName = opts.mirrorName ?? 'mirror';
  const onWarn = opts.onWarn ?? ((info) => process.stderr.write(`[sync] cross-link target ${info.type}/${info.slug} not found on mirror ${mirrorName}\n`));
  const counters = { written: 0, rewritten: 0, deleted: 0, warnings: 0, indexed: false, srcParseErrors: 0 };

  // Pass 0
  await dst.ensureStructure();

  // Enumerate + read source bodies once.
  // Use listPagesWithErrors when available so parse failures are visible and
  // cannot silently cause mirror deletions.
  let srcList;
  let srcParseErrors = [];
  if (typeof src.listPagesWithErrors === 'function') {
    const result = await src.listPagesWithErrors({ in: 'pages' });
    srcList = result.pages;
    srcParseErrors = result.parseErrors ?? [];
  } else {
    srcList = await src.listPages({ in: 'pages' });
  }
  counters.srcParseErrors = srcParseErrors.length;

  const dstList = await dst.listPages({ in: 'pages' });

  const srcIndex = new Map();                  // key "<type>/<slug>" → { srcPath, frontmatter, body }
  for (const { path: srcPath, frontmatter } of srcList) {
    const { body } = await src.readPage(srcPath);
    srcIndex.set(`${frontmatter.type}/${frontmatter.id}`, { srcPath, frontmatter, body });
  }
  const dstIndex = new Map();
  for (const { path: dstPath, frontmatter } of dstList) {
    dstIndex.set(`${frontmatter.type}/${frontmatter.id}`, dstPath);
  }

  // Pass 1 — write/upsert with sentinel bodies.
  for (const [, { srcPath, frontmatter, body }] of srcIndex) {
    const stub = stripCrossLinks(body, src, srcPath);
    await dst.writePage({
      type: frontmatter.type,
      slug: frontmatter.id,
      frontmatter,
      body: stub,
      onConflict: 'overwrite',
    });
    counters.written++;
  }

  // Pass 2 — rewrite cross-links now that all dst pages exist.
  for (const [, { srcPath, frontmatter, body }] of srcIndex) {
    const dstPath = dst.pathFor({ type: frontmatter.type, slug: frontmatter.id });
    const rewritten = rewriteCrossLinks(body, src, srcPath, dst, dstPath, {
      onWarn: (info) => { counters.warnings++; onWarn(info); },
    });
    await dst.mutatePage(dstPath, { setBody: rewritten });
    counters.rewritten++;
  }

  // Pass 3 — delete pages in dst that are not in src.
  // SAFETY: if the source enumeration had ANY parse failures, skip all deletes.
  // A malformed-frontmatter source page was dropped from srcList and therefore
  // absent from srcIndex — deleting its mirror copy would be data loss caused
  // by a typo on the primary, not a legitimate removal.
  if (srcParseErrors.length === 0) {
    for (const [key, dstPath] of dstIndex) {
      if (!srcIndex.has(key)) {
        await dst.deletePage(dstPath);
        counters.deleted++;
      }
    }
  } else {
    const names = srcParseErrors.map(e => e.path).join(', ');
    process.stderr.write(`[sync] WARNING: skipping delete pass — ${srcParseErrors.length} source page(s) could not be parsed: ${names}\n`);
  }

  // Pass 4 — regenerate Index on dst.
  await dst.regenerateIndex();
  counters.indexed = true;

  return counters;
}
