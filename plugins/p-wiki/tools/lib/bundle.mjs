import { today } from './paths.mjs';

export function buildBundle(dest) {
  const listed = dest.listPages({ in: 'pages' });
  const pages = [];
  for (const { path, frontmatter } of listed) {
    const { body } = dest.readPage(path);
    pages.push({ type: frontmatter.type, id: frontmatter.id, path, frontmatter, body });
  }
  pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // stable output
  return { schema: 1, generated: today(), wikiRoot: 'docs/wiki', pages };
}
