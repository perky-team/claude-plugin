import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_REL = 'docs/wiki/.pwiki.json';

export function configPath(root) { return join(root, CONFIG_REL); }

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  return JSON.parse(text);
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function validateConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (cfg.destination !== 'fs' && cfg.destination !== 'confluence') return { ok: false, error: 'destination must be "fs" or "confluence"' };
  if (cfg.destination === 'fs') return { ok: true };
  const c = cfg.confluence;
  if (!c || typeof c !== 'object') return { ok: false, error: 'confluence section required' };
  for (const f of ['siteUrl', 'spaceKey', 'spaceId', 'rootPageId']) {
    if (typeof c[f] !== 'string' || !c[f]) return { ok: false, error: `confluence.${f} required` };
  }
  if (!c.subParents || typeof c.subParents !== 'object') return { ok: false, error: 'confluence.subParents required' };
  for (const t of ['concept', 'person', 'source', 'query']) {
    if (typeof c.subParents[t] !== 'string' || !c.subParents[t]) return { ok: false, error: `confluence.subParents.${t} required` };
  }
  return { ok: true };
}
