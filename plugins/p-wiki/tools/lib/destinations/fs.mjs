import { existsSync, writeFileSync, readFileSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serializeFrontmatter, parseFrontmatter } from '../fm.mjs';
import { directoryFor } from '../schema.mjs';
import { withDateSuffix } from '../slug.mjs';
import { toRepoRelative, today } from '../paths.mjs';
import { rankDocuments } from '../search.mjs';
import { runChecks } from '../lint.mjs';
import { findFirstMatch, insertLinkAt, computeRelPath } from '../backlinks.mjs';
import { extractSummary, renderIndex } from '../index.mjs';

export function createFsDestination({ rootPath, root }) {
  // TODO(Task 4 cleanup): drop {rootPath} fallback once nothing in-tree uses it.
  rootPath = rootPath ?? root;
  const absFor = (type, slug) => join(rootPath, 'docs', 'wiki', directoryFor(type), `${slug}.md`);
  const repoRel = (abs) => toRepoRelative(rootPath, abs);

  function writePage({ type, slug, frontmatter, body, onConflict }) {
    const conflict = onConflict ?? 'fail';
    let useSlug = slug;
    let abs = absFor(type, useSlug);
    if (existsSync(abs)) {
      if (conflict === 'fail') {
        return {
          path: '',
          id: useSlug,
          slug: useSlug,
          created: false,
          existingPath: repoRel(abs),
          dateSuffixSlug: withDateSuffix(slug, today()),
        };
      }
      if (conflict === 'date-suffix') {
        useSlug = withDateSuffix(slug, today());
        abs = absFor(type, useSlug);
        // recurse-suffix on collision is out of scope: we trust today's slug to be unique
      }
      // overwrite: fall through
    }
    mkdirSync(dirname(abs), { recursive: true });
    const fm = { ...frontmatter, id: useSlug };
    writeFileSync(abs, serializeFrontmatter(fm, body), 'utf-8');
    return { path: repoRel(abs), id: useSlug, slug: useSlug, created: true };
  }

  function readPage(repoRelPath) {
    const abs = join(rootPath, repoRelPath);
    if (!existsSync(abs)) throw new Error(`page not found: ${repoRelPath}`);
    const text = readFileSync(abs, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(text);
    return { frontmatter, body, path: repoRelPath };
  }

  function mutatePage(repoRelPath, mutations) {
    const { frontmatter, body } = readPage(repoRelPath);
    const changed = [];
    const newFm = { ...frontmatter };

    if (mutations.setFields) {
      for (const [k, v] of Object.entries(mutations.setFields)) {
        if (newFm[k] !== v) { newFm[k] = v; changed.push(k); }
      }
    }
    if (mutations.addTag) {
      const tags = newFm.tags ?? [];
      if (!tags.includes(mutations.addTag)) {
        newFm.tags = [...tags, mutations.addTag];
        changed.push('tags');
      }
    }
    if (mutations.removeTag) {
      const tags = newFm.tags ?? [];
      if (tags.includes(mutations.removeTag)) {
        newFm.tags = tags.filter(t => t !== mutations.removeTag);
        changed.push('tags');
      }
    }
    if (mutations.addSources) {
      const src = newFm.sources ?? [];
      const added = mutations.addSources.filter(s => !src.includes(s));
      if (added.length) {
        newFm.sources = [...src, ...added];
        changed.push('sources');
      }
    }
    if (mutations.addInformedBy) {
      const ib = newFm['informed-by'] ?? [];
      const added = mutations.addInformedBy.filter(s => !ib.includes(s));
      if (added.length) {
        newFm['informed-by'] = [...ib, ...added];
        changed.push('informed-by');
      }
    }
    if (mutations.addCompiledTo) {
      const ct = newFm['compiled-to'] ?? [];
      const added = mutations.addCompiledTo.filter(s => !ct.includes(s));
      if (added.length) {
        newFm['compiled-to'] = [...ct, ...added];
        changed.push('compiled-to');
      }
    }
    if (mutations.bumpUpdated) {
      const t = today();
      if (newFm.updated !== t) { newFm.updated = t; changed.push('updated'); }
    }
    if (mutations.markCompiled) {
      if (newFm.compiled !== true) { newFm.compiled = true; changed.push('compiled'); }
    }
    if (mutations.removeFields) {
      for (const k of mutations.removeFields) {
        if (k in newFm) { delete newFm[k]; changed.push(k); }
      }
    }

    if (changed.length === 0) return { path: repoRelPath, changed: [], noop: true };

    writeFileSync(join(rootPath, repoRelPath), serializeFrontmatter(newFm, body), 'utf-8');
    return { path: repoRelPath, changed: [...new Set(changed)], noop: false };
  }

  function movePage(fromRel, toRel) {
    const fromAbs = join(rootPath, fromRel);
    const toAbs = join(rootPath, toRel);
    if (!existsSync(fromAbs)) throw new Error(`page not found: ${fromRel}`);
    if (existsSync(toAbs)) throw new Error(`target exists: ${toRel}`);
    mkdirSync(dirname(toAbs), { recursive: true });
    renameSync(fromAbs, toAbs);
  }

  function walkDir(start, out) {
    if (!existsSync(start)) return;
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        const p = join(cur, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else if (entry.isFile() && p.endsWith('.md')) {
          try {
            const text = readFileSync(p, 'utf-8');
            const { frontmatter } = parseFrontmatter(text);
            out.push({ path: repoRel(p), frontmatter });
          } catch { /* skip unparseable */ }
        }
      }
    }
  }

  function listPages(opts) {
    const where = opts?.in ?? 'pages';
    const subdirs = where === 'raw' ? ['raw'] : where === 'all' ? ['pages', 'raw'] : ['pages'];
    const out = [];
    for (const sub of subdirs) {
      walkDir(join(rootPath, 'docs', 'wiki', sub), out);
    }
    let filtered = out;
    if (opts?.types?.length) {
      filtered = filtered.filter(p => opts.types.includes(p.frontmatter.type));
    }
    return filtered;
  }

  function pageExists({ type, slug }) {
    return existsSync(absFor(type, slug));
  }

  function pathFor({ type, slug }) {
    const abs = absFor(type, slug);
    return repoRel(abs);
  }

  function deletePage(repoRelPath) {
    const abs = join(rootPath, repoRelPath);
    try {
      unlinkSync(abs);
      return { deleted: true, path: repoRelPath };
    } catch (e) {
      if (e.code === 'ENOENT') return { deleted: false, path: repoRelPath };
      throw e;
    }
  }

  function search(query, opts = {}) {
    const where = opts.in ?? 'pages';
    const all = listPages({ in: where });
    // Read bodies (listPages returns frontmatter only)
    const docs = [];
    for (const { path } of all) {
      try {
        const text = readFileSync(join(rootPath, path), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(text);
        docs.push({ path, frontmatter, body });
      } catch { /* skip */ }
    }
    let filtered = docs;
    if (opts.type?.length) filtered = filtered.filter(d => opts.type.includes(d.frontmatter.type));
    if (opts.tags?.length) filtered = filtered.filter(d => {
      const dt = d.frontmatter.tags ?? [];
      return opts.tags.some(t => dt.includes(t));
    });
    const results = rankDocuments(query, filtered, { limit: opts.limit ?? 10, snippet: opts.snippet ?? true });
    return { total: results.length, results };
  }

  function lint(opts = {}) {
    const docs = [];
    for (const { path } of listPages({ in: 'all' })) {
      try {
        const text = readFileSync(join(rootPath, path), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(text);
        docs.push({ path, frontmatter, body });
      } catch { /* skip unparseable */ }
    }
    return runChecks(docs, { repoRoot: rootPath, existsFn: existsSync });
  }

  function applyBacklinks({ targetPath, maxSuggestions = 20, force = false }) {
    const target = readPage(targetPath);
    const title = (target.frontmatter.title ?? '').trim();
    if (!title) throw new Error(`applyBacklinks: target has no title: ${targetPath}`);

    const all = listPages({ in: 'pages' });
    // Build candidate list: every page except target.
    const candidates = [];
    for (const { path } of all) {
      if (path === targetPath) continue;
      let text;
      try { text = readFileSync(join(rootPath, path), 'utf-8'); } catch { continue; }
      const { body } = parseFrontmatter(text);
      const m = findFirstMatch(body, title);
      if (m) {
        // Preview: 30 chars on each side of the match, single line, ellipsized.
        const lineStart = Math.max(0, m.index - 30);
        const lineEnd = Math.min(body.length, m.index + m.length + 30);
        const preview = body.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
        candidates.push({ file: path, line: m.line, match: m, body, preview });
      }
    }

    if (candidates.length > maxSuggestions && !force) {
      return {
        target: targetPath,
        title,
        suspicious: true,
        total: candidates.length,
        candidates: candidates.map(c => ({ file: c.file, line: c.line, preview: c.preview })),
      };
    }

    const inserted = [];
    for (const c of candidates) {
      const rel = computeRelPath(c.file, targetPath);
      const replacement = `[${title}](${rel})`;
      const text = readFileSync(join(rootPath, c.file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(text);
      const newBody = insertLinkAt(body, c.match, replacement);
      const newText = serializeFrontmatter(frontmatter, newBody);
      const abs = join(rootPath, c.file);
      writeFileSync(abs + '.tmp', newText, 'utf-8');
      renameSync(abs + '.tmp', abs);
      inserted.push({ file: c.file, line: c.line });
    }

    return { target: targetPath, title, inserted, total: inserted.length };
  }

  function regenerateIndex() {
    const allPages = listPages({ in: 'pages' });
    const groups = { concept: [], person: [], source: [], query: [] };
    for (const { path, frontmatter } of allPages) {
      const t = frontmatter.type;
      if (!(t in groups)) continue;
      const text = readFileSync(join(rootPath, path), 'utf-8');
      const { body } = parseFrontmatter(text);
      // Strip leading 'docs/wiki/' so the link is relative to index.md (which lives in docs/wiki/).
      const relPath = path.startsWith('docs/wiki/') ? path.slice('docs/wiki/'.length) : path;
      groups[t].push({
        id: frontmatter.id,
        title: frontmatter.title,
        path: relPath,
        summary: extractSummary(body),
      });
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const text = renderIndex(groups);
    const abs = join(rootPath, 'docs', 'wiki', 'index.md');
    writeFileSync(abs + '.tmp', text, 'utf-8');
    renameSync(abs + '.tmp', abs);
    return {
      path: 'docs/wiki/index.md',
      groups: {
        concept: groups.concept.length,
        person: groups.person.length,
        source: groups.source.length,
        query: groups.query.length,
      },
      written: true,
    };
  }

  return {
    kind: 'fs',
    rootPath,
    pageExists,
    pathFor,
    readPage,
    writePage,
    mutatePage,
    movePage,
    deletePage,
    listPages,
    search,
    lint,
    applyBacklinks,
    regenerateIndex,
  };
}
