import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Config / validation errors -> exit 2 at the CLI (visible to p-shed as a broken
// guard, never as quiet).
export class ConfigError extends Error {}

export function findRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function paths(root) {
  const dir = join(root, '.pchat');
  return {
    dir,
    config: join(root, '.pchat.json'), // committed; contains no secrets
    offset: join(dir, 'offset.json'),  // gitignored state
    log: join(dir, 'log.jsonl'),       // local channel log
  };
}

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

const DEFAULTS = {
  apiBase: 'https://api.telegram.org', // overridable: the test seam for the mock Bot API
  sessionFile: '.pchat/session.md',
  commandTimeoutSec: 15,
  apiTimeoutSec: 10,
};

export function readConfig(root) {
  const p = paths(root).config;
  if (!existsSync(p)) throw new ConfigError('.pchat.json not found — run pchat init first');
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf-8')); }
  catch (e) { throw new ConfigError(`.pchat.json is not valid JSON: ${e.message}`); }
  return { ...DEFAULTS, commands: {}, ...cfg };
}

// Fail-closed allowlist: an empty/missing allowlist is a hard error (exit 2 ->
// p-shed guard-error -> breaker -> visible), never "respond to anyone".
export function requireAllowlist(cfg) {
  if (!Array.isArray(cfg.allowedChatIds) || cfg.allowedChatIds.length === 0) {
    throw new ConfigError('allowedChatIds must be a non-empty array in .pchat.json');
  }
  return cfg.allowedChatIds;
}

export function resolveTokenPath(p, root) {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(root, e);
}

// The token lives ONLY in this file — never argv, env dumps, repo files, or logs.
export function readToken(cfg, root) {
  if (!cfg.tokenFile) throw new ConfigError('tokenFile missing from .pchat.json');
  const p = resolveTokenPath(cfg.tokenFile, root);
  if (!existsSync(p)) throw new ConfigError(`token file not found: ${p}`);
  const token = readFileSync(p, 'utf-8').trim();
  if (!token) throw new ConfigError(`token file is empty: ${p}`);
  return token;
}

// POSIX-only 600 check (file mode is meaningless on Windows). Warn, don't fail.
export function tokenPermsWarning(cfg, root) {
  if (process.platform === 'win32') return null;
  try {
    const p = resolveTokenPath(cfg.tokenFile, root);
    const mode = statSync(p).mode & 0o777;
    if (mode & 0o077) return `token file ${p} is mode ${mode.toString(8)} — chmod 600 it`;
  } catch { return null; }
  return null;
}
