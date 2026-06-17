import { resolve } from 'node:path';
import { findWikiRoot } from './paths.mjs';
import { createFsDestination } from './destinations/fs.mjs';
import { createConfluenceDestination } from './destinations/confluence.mjs';
import { readConfig, validateConfig } from './config.mjs';

/**
 * @typedef {Object} Destination
 * @property {(path: string) => Promise<{deleted: boolean, path: string}> | {deleted: boolean, path: string}} deletePage
 * @property {(args: {type: string, slug: string}) => string} pathFor
 * @property {() => Promise<void> | void} ensureStructure
 */

/**
 * @typedef {Object} ResolvedDestinations
 * @property {Destination} primary
 * @property {string} primaryName
 * @property {Destination[]} mirrors   - same length and order as mirrorNames; entries lazily constructed
 * @property {string[]} mirrorNames
 * @property {Destination[]} sources   - same length and order as sourceNames; entries lazily constructed
 * @property {string[]} sourceNames
 */

const DEFAULT_FS_CONFIG = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };

function makeDestination(name, block, root, env) {
  if (block.kind === 'fs') {
    const fsRoot = block.path ? resolve(root, block.path) : root;
    return createFsDestination({ root: fsRoot, destinationConfig: block });
  }
  if (block.kind === 'confluence') {
    if (env._spyConfluenceFactory) env._spyConfluenceFactory(name);
    return createConfluenceDestination({ root, destinationConfig: block, transport: env.transport });
  }
  throw new Error(`unknown destination kind: ${block.kind}`);
}

/**
 * @param {{cwd: string, transport?: Function, _spyConfluenceFactory?: (name: string) => void}} env
 * @returns {ResolvedDestinations | null}
 */
export function resolveDestination(env) {
  const root = findWikiRoot(env.cwd);
  if (root === null) return null;
  const cfg = readConfig(root) ?? DEFAULT_FS_CONFIG;
  const v = validateConfig(cfg);
  if (!v.ok) throw new Error(`invalid .pwiki.json: ${v.error}`);

  const primaryName = cfg.primary;
  const primary = makeDestination(primaryName, cfg.destinations[primaryName], root, env);

  function lazyList(names) {
    const cache = new Array(names.length);
    return new Proxy(cache, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const i = Number(prop);
          if (target[i] === undefined && i < names.length) {
            const name = names[i];
            target[i] = makeDestination(name, cfg.destinations[name], root, env);
          }
          return target[i];
        }
        return Reflect.get(target, prop);
      },
    });
  }

  const mirrorNames = [...(cfg.mirrors ?? [])];
  const mirrors = lazyList(mirrorNames);
  const sourceNames = [...(cfg.sources ?? [])];
  const sources = lazyList(sourceNames);

  return { primary, primaryName, mirrors, mirrorNames, sources, sourceNames };
}
