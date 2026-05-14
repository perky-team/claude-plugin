import { existsSync, writeFileSync, readFileSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serializeFrontmatter, parseFrontmatter } from '../fm.mjs';
import { directoryFor } from '../schema.mjs';
import { withDateSuffix } from '../slug.mjs';
import { toRepoRelative, today } from '../paths.mjs';

export function createFsDestination({ rootPath }) {
  const notImpl = () => { throw new Error('not implemented yet'); };

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

  return {
    kind: 'fs',
    rootPath,
    pageExists,
    readPage,
    writePage,
    mutatePage,
    movePage,
    listPages,
    search: notImpl,
    lint: notImpl,
  };
}
