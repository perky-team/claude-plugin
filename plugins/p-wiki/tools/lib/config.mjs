import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_REL = 'docs/wiki/.pwiki.json';
const TYPES = ['concept', 'person', 'source', 'query'];

export function configPath(root) { return join(root, CONFIG_REL); }

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  const raw = JSON.parse(text);
  if (raw && typeof raw === 'object' && 'primary' in raw) return raw;            // v3 already
  if (raw && typeof raw === 'object' && 'destination' in raw) {
    const migrated = migrateV2(raw);
    writeConfig(root, migrated);                                                  // persist immediately
    return migrated;
  }
  return raw;                                                                     // validateConfig will reject downstream
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function migrateV2(old) {
  const kind = old.destination;
  const block = kind === 'fs' ? { kind: 'fs' } : { kind: 'confluence', ...old.confluence };
  return { primary: kind, mirrors: [], destinations: { [kind]: block } };
}

export function validateConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (typeof cfg.primary !== 'string' || !cfg.primary) return { ok: false, error: 'primary must be a non-empty string' };
  if (!cfg.destinations || typeof cfg.destinations !== 'object') return { ok: false, error: 'destinations must be an object' };
  if (cfg.mirrors !== undefined && !Array.isArray(cfg.mirrors)) return { ok: false, error: 'mirrors must be an array of strings' };
  if (!(cfg.primary in cfg.destinations)) return { ok: false, error: `destinations.${cfg.primary} not defined (primary references unknown name)` };
  for (const m of cfg.mirrors ?? []) {
    if (typeof m !== 'string' || !m) return { ok: false, error: 'mirror name must be a non-empty string' };
    if (!(m in cfg.destinations)) return { ok: false, error: `mirror "${m}" not defined in destinations` };
  }
  for (const [name, block] of Object.entries(cfg.destinations)) {
    if (!block || typeof block !== 'object') return { ok: false, error: `destinations.${name} must be an object` };
    if (block.kind !== 'fs' && block.kind !== 'confluence') return { ok: false, error: `destinations.${name}.kind must be "fs" or "confluence"` };
    if (block.kind === 'confluence') {
      for (const f of ['siteUrl', 'spaceKey', 'spaceId', 'rootPageId']) {
        if (typeof block[f] !== 'string' || !block[f]) return { ok: false, error: `destinations.${name}.${f} required` };
      }
      if (block.titlePrefix !== undefined && (typeof block.titlePrefix !== 'string' || !block.titlePrefix)) return { ok: false, error: `destinations.${name}.titlePrefix must be a non-empty string` };
      if (!block.subParents || typeof block.subParents !== 'object') return { ok: false, error: `destinations.${name}.subParents required` };
      for (const t of TYPES) {
        if (typeof block.subParents[t] !== 'string' || !block.subParents[t]) return { ok: false, error: `destinations.${name}.subParents.${t} required` };
      }
    }
  }
  return { ok: true };
}
