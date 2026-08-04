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
// "a different version", not "an older" one: this banner also prints when the
// stored graph is NEWER than the code (a plugin rollback), and it must not print
// for a graph this process just erased — that graph holds nothing at all, which
// is a different problem with a different answer. See `erased` below.
const SCHEMA_STALE_BANNER =
  `⚠ p-graph STALE: graph was built by a different version of p-graph; results may be wrong. Run /p-graph:sync`;

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
  // A stale schema needs a full rebuild even with zero file drift (the on-disk
  // node shape/qnames are from an older version); indexChanged routes to a full
  // reindex when schemaStale. Otherwise zero drift means someone else refreshed.
  if (driftCount(actionable) === 0 && !store.schemaStale?.()) return { refreshed: true };

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
// graph and prints a staleness banner. Never throws.
//
// Returns `{ erased: true }` when the graph tables are gone and nothing rebuilt
// them, so the caller must refuse to answer instead of printing an empty answer.
// Returns nothing in every other case, including a merely stale graph — that one
// still answers, with a banner.
export async function ensureFresh(ctx) {
  const { command, opts, root, store, ignorePatterns, pgraphDir, warn } = ctx;
  if (!QUERY_COMMANDS.has(command)) return;

  // openStore drops the graph tables the moment any command opens a database
  // written by an older version, so the graph is empty right now. It stays empty
  // until a rebuild refills it and raises the stored schema version — which is
  // why both facts are needed: `graphErased` stays true on the store even after
  // a successful rebuild in this same process.
  const erased = () => Boolean(store.graphErased) && (store.schemaStale?.() ?? false);

  // A schema upgrade must rebuild even when git can't report drift at all (a
  // non-git checkout, or git missing): openStore already dropped the graph
  // tables in that case, so skipping the rebuild here would leave every query
  // answering empty, with an empty gap report, forever.
  const schemaStale = store.schemaStale?.() ?? false;

  let change;
  try { change = gitChangedFiles(root, store.getMeta('indexed_sha')); }
  catch { change = null; }
  if (change === null && !schemaStale) { warn(UNKNOWN_BANNER); return; } // not a git checkout, nothing else forces a rebuild

  const drift = change === null ? 0 : driftCount(computeActionable(change, ignorePatterns));
  // A schema upgrade must rebuild even when no files changed: the stored graph
  // was written in an older node/qname shape, so it's wrong until reindexed.
  if (drift === 0 && !schemaStale) return; // fresh — fast path

  // Opt-out (--stale-ok or PGRAPH_AUTOREFRESH=0). The user asked for no rebuild,
  // so there is none — but an erased graph has no stale answer to give either, so
  // report it instead of a banner the caller can print above an empty answer.
  if (!autorefreshEnabled(opts)) {
    if (erased()) return { erased: true };
    warn(schemaStale ? SCHEMA_STALE_BANNER : staleBanner(drift));
    return;
  }

  try {
    const { acquired, result } = await withReindexLock(pgraphDir, {}, () => doReindex(ctx));
    if (acquired && result?.refreshed) return; // fresh graph, no banner
  } catch { /* fall through to banner */ }
  // Timed out, partial, or errored. A rebuild was tried and did not finish, so an
  // erased graph is still erased.
  if (erased()) return { erased: true };
  warn(schemaStale && drift === 0 ? SCHEMA_STALE_BANNER : staleBanner(drift));
}
