import { findWikiRoot } from './paths.mjs';
import { createFsDestination } from './destinations/fs.mjs';

/**
 * @typedef {Object} Destination
 * @property {'fs'} kind
 * @property {string} rootPath
 * @property {(args: {type: string, slug: string}) => boolean} pageExists
 * @property {(path: string) => {frontmatter: object, body: string, path: string}} readPage
 * @property {(args: {type: string, slug: string, frontmatter: object, body: string, onConflict?: 'fail'|'date-suffix'|'overwrite'}) => {path: string, id: string, slug: string, created: boolean, existingPath?: string, dateSuffixSlug?: string}} writePage
 * @property {(path: string, mutations: object) => {path: string, changed: string[], noop: boolean}} mutatePage
 * @property {(fromPath: string, toPath: string) => void} movePage
 * @property {(opts?: {types?: string[], in?: 'pages'|'raw'|'all'}) => Array<{path: string, frontmatter: object}>} listPages
 * @property {(query: string, opts: object) => {total: number, results: Array<object>}} search
 * @property {(opts?: object) => {errors: object, warnings: object, totals: {errors: number, warnings: number}}} lint
 */

/**
 * @param {{cwd: string}} env
 * @returns {Destination | null}
 */
export function resolveDestination(env) {
  const root = findWikiRoot(env.cwd);
  if (root === null) return null;
  return createFsDestination({ rootPath: root });
}
