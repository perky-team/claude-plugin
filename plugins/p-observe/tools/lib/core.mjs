import { existsSync } from 'node:fs';
import { createPshedAdapter } from './adapters/pshed.mjs';
import { createPtasksAdapter } from './adapters/ptasks.mjs';
import { createPgraphAdapter } from './adapters/pgraph.mjs';
import { createPwikiAdapter } from './adapters/pwiki.mjs';
import { replayJournal } from './journal.mjs';

export function buildAdapters({ root, cfg, paths, detected, emit }) {
  const a = {};
  if (detected.pshed) a.pshed = createPshedAdapter({ root, paths, cfg, emit });
  if (detected.ptasks) a.ptasks = createPtasksAdapter({ root, paths, cfg, emit });
  if (detected.pgraph) a.pgraph = createPgraphAdapter({ root, paths, cfg, emit });
  if (detected.wiki) {
    const w = createPwikiAdapter({ root, paths, cfg, emit });
    if (w.enabled()) a.wiki = w; // Confluence-primary blind zone -> skip
  }
  return a;
}

export function runBackfill(adapters, { paths, emit }) {
  if (existsSync(paths.journalFile)) {
    for (const e of replayJournal(paths.journalFile)) emit(e);
    return;
  }
  for (const ad of Object.values(adapters)) ad.backfill();
}

export function startAll(adapters) { for (const ad of Object.values(adapters)) ad.start(); }
export function stopAll(adapters) { for (const ad of Object.values(adapters)) ad.stop(); }

export function collectStatus(adapters) {
  const snap = {};
  for (const [name, ad] of Object.entries(adapters)) snap[name] = ad.status();
  return snap;
}
