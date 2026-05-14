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

  return {
    kind: 'fs',
    rootPath,
    pageExists: notImpl,
    readPage: notImpl,
    writePage,
    mutatePage: notImpl,
    movePage: notImpl,
    listPages: notImpl,
    search: notImpl,
    lint: notImpl,
  };
}
