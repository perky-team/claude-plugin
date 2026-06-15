import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_REL = 'docs/tasks/.ptasks.json';

export function configPath(root) {
  return join(root, CONFIG_REL);
}

export function defaultConfig() {
  return { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
}

export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return defaultConfig();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'));
  } catch (e) {
    throw Object.assign(new Error(`invalid ${CONFIG_REL}: ${e.message}`), { code: 'config-invalid' });
  }
  const v = validateConfig(parsed);
  if (!v.ok) throw Object.assign(new Error(`invalid ${CONFIG_REL}: ${v.error}`), { code: 'config-invalid' });
  return parsed;
}

export function writeConfig(root, cfg) {
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (typeof cfg.primary !== 'string' || !cfg.primary) return { ok: false, error: 'primary must be a non-empty string' };
  if (!cfg.destinations || typeof cfg.destinations !== 'object') return { ok: false, error: 'destinations must be an object' };
  if (cfg.mirrors !== undefined && !Array.isArray(cfg.mirrors)) return { ok: false, error: 'mirrors must be an array of strings' };
  if (!(cfg.primary in cfg.destinations)) return { ok: false, error: `destinations.${cfg.primary} not defined` };
  for (const m of cfg.mirrors ?? []) {
    if (typeof m !== 'string' || !m) return { ok: false, error: 'mirror name must be a non-empty string' };
    if (!(m in cfg.destinations)) return { ok: false, error: `mirror "${m}" not in destinations` };
  }
  for (const [name, block] of Object.entries(cfg.destinations)) {
    if (!block || typeof block !== 'object') return { ok: false, error: `destinations.${name} must be an object` };
    if (block.kind !== 'fs' && block.kind !== 'jira') return { ok: false, error: `destinations.${name}.kind must be "fs" or "jira"` };
    if (block.kind === 'jira') {
      for (const f of ['siteUrl', 'projectKey']) {
        if (typeof block[f] !== 'string' || !block[f]) return { ok: false, error: `destinations.${name}.${f} required` };
      }
    }
  }
  return { ok: true };
}
