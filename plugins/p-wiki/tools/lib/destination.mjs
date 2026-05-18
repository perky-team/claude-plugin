import { findWikiRoot } from './paths.mjs';
import { createFsDestination } from './destinations/fs.mjs';
import { createConfluenceDestination } from './destinations/confluence.mjs';
import { readConfig, validateConfig } from './config.mjs';

/**
 * @typedef {Object} ResolvedDestinations
 * @property {Destination} primary
 * @property {string} primaryName
 * @property {Destination[]} mirrors   - same length and order as mirrorNames; entries lazily constructed
 * @property {string[]} mirrorNames
 */

const DEFAULT_FS_CONFIG = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };

function makeDestination(name, block, root, env) {
  if (block.kind === 'fs') return createFsDestination({ root, destinationConfig: block });
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

  const mirrorNames = [...(cfg.mirrors ?? [])];
  const mirrorCache = new Array(mirrorNames.length);
  const mirrors = new Proxy(mirrorCache, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const i = Number(prop);
        if (target[i] === undefined && i < mirrorNames.length) {
          const name = mirrorNames[i];
          target[i] = makeDestination(name, cfg.destinations[name], root, env);
        }
        return target[i];
      }
      return Reflect.get(target, prop);
    },
  });

  return { primary, primaryName, mirrors, mirrorNames };
}
