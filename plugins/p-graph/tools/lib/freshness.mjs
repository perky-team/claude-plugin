import { gitChangedFiles, indexChanged, headSha } from './index/build.mjs';
import { withReindexLock } from './index/lock.mjs';
import { isIgnored } from './config.mjs';
import { resolveLang } from './parse/index.mjs';

const QUERY_COMMANDS = new Set([
  'search', 'node', 'callers', 'callees', 'impact', 'trace', 'context', 'explore', 'files',
]);

const staleBanner = (n) =>
  `⚠ p-graph STALE: ${n} files changed since index; results may be wrong. Run /p-graph:sync`;
const UNKNOWN_BANNER =
  `⚠ p-graph STALE: cannot verify freshness (not a git checkout); results may be wrong. Run /p-graph:sync`;

// Only files the graph actually indexes count as drift. git reports every changed
// path, but indexChanged skips ignored and non-source files — counting the raw
// git output would make an uncommitted README.md edit look like perpetual drift.
export function computeActionable(change, ignorePatterns) {
  return {
    modified: change.modified.filter((rel) => !isIgnored(rel, ignorePatterns) && resolveLang(rel)),
    deleted: change.deleted.filter((rel) => !isIgnored(rel, ignorePatterns)),
  };
}
export const driftCount = (a) => a.modified.length + a.deleted.length;

function autorefreshEnabled(opts) {
  return process.env.PGRAPH_AUTOREFRESH !== '0' && !opts['stale-ok'];
}

// Runs under the reindex lock. Re-checks drift (another process may have just
// refreshed), then reparses the actionable set in place. Returns { refreshed }.
async function doReindex(ctx) {
  const { root, store, ignorePatterns, warn } = ctx;
  const change = gitChangedFiles(root, store.getMeta('indexed_sha'));
  const actionable = change ? computeActionable(change, ignorePatterns) : { modified: [], deleted: [] };
  if (driftCount(actionable) === 0) return { refreshed: true }; // someone else refreshed while we waited

  warn(store.schemaStale?.()
    ? 'p-graph: rebuilding graph after schema upgrade…'
    : `p-graph: refreshing ${driftCount(actionable)} changed files…`);

  let failed = 0;
  await indexChanged({
    root, store, ignorePatterns,
    changedFiles: () => actionable,
    onError: () => { failed++; },
  });
  if (failed > 0) return { refreshed: false }; // partial — keep flagging drift
  const sha = headSha(root);
  if (sha) store.setMeta('indexed_sha', sha);
  return { refreshed: true };
}

// Called before every query command. Refreshes the graph if it has drifted and
// auto-refresh is enabled; otherwise (or on any failure) answers from the current
// graph and prints a staleness banner. Never throws — a query must always answer.
export async function ensureFresh(ctx) {
  const { command, opts, root, store, ignorePatterns, pgraphDir, warn } = ctx;
  if (!QUERY_COMMANDS.has(command)) return;

  let change;
  try { change = gitChangedFiles(root, store.getMeta('indexed_sha')); }
  catch { change = null; }
  if (change === null) { warn(UNKNOWN_BANNER); return; } // not a git checkout

  const drift = driftCount(computeActionable(change, ignorePatterns));
  if (drift === 0) return; // fresh — fast path

  if (!autorefreshEnabled(opts)) { warn(staleBanner(drift)); return; } // opt-out

  try {
    const { acquired, result } = await withReindexLock(pgraphDir, {}, () => doReindex(ctx));
    if (acquired && result?.refreshed) return; // fresh graph, no banner
  } catch { /* fall through to banner */ }
  warn(staleBanner(drift)); // timed out, partial, or errored
}
