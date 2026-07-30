import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError, paths } from './config.mjs';

export function readOffset(root) {
  const p = paths(root).offset;
  if (!existsSync(p)) return { confirmed: 0, lastPollAt: null };
  try { return { confirmed: 0, lastPollAt: null, ...JSON.parse(readFileSync(p, 'utf-8')) }; }
  catch { return { confirmed: 0, lastPollAt: null }; } // corrupt -> safe zero (re-serve, never skip)
}

export function writeOffset(root, offset) {
  mkdirSync(paths(root).dir, { recursive: true });
  writeFileSync(paths(root).offset, JSON.stringify(offset, null, 2) + '\n', 'utf-8');
}

// Monotonic by contract: Telegram confirms EVERYTHING below the offset, so moving
// the cursor backwards can only re-serve already-answered messages — a caller
// acking a stale id is a bug worth surfacing, not silently clamping.
export function ackUntil(root, until) {
  if (!Number.isInteger(until) || until < 0) throw new ConfigError(`invalid --until: ${until} (expected an update_id)`);
  const cur = readOffset(root);
  if (until < cur.confirmed) throw new ConfigError(`cannot ack backwards: confirmed=${cur.confirmed}, until=${until}`);
  const next = { ...cur, confirmed: until };
  writeOffset(root, next);
  return next;
}

export function appendLocalLog(root, rec) {
  mkdirSync(paths(root).dir, { recursive: true });
  appendFileSync(paths(root).log, JSON.stringify(rec) + '\n', 'utf-8');
}

export function sessionPath(root, cfg) {
  const p = cfg.sessionFile ?? '.pchat/session.md';
  return isAbsolute(p) ? p : resolve(root, p);
}

export function resetSession(root, cfg) {
  const p = sessionPath(root, cfg);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf-8');
  return p;
}

export function sessionStatus(root, cfg) {
  const p = sessionPath(root, cfg);
  try { return { file: p, bytes: statSync(p).size }; }
  catch { return { file: p, bytes: 0 }; }
}

export function ensureGitignore(root) {
  const p = join(root, '.gitignore');
  const line = '.pchat/';
  const cur = existsSync(p) ? readFileSync(p, 'utf-8') : '';
  if (cur.split(/\r?\n/).includes(line)) return false;
  writeFileSync(p, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + line + '\n', 'utf-8');
  return true;
}
