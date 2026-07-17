import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

const DEFAULTS = {
  roots: { pshed: '.pshed', ptasks: 'docs/tasks/tasks.yml', pgraph: '.pgraph/graph.db', wiki: 'docs/wiki' },
  pgraphCli: null,
  nodeBin: 'node',
  bufferSize: 500,
  journal: false,
  journalRetentionDays: 7,
};

export function loadConfig(root) {
  const p = join(root, '.pobserve.json');
  if (!existsSync(p)) return { ...DEFAULTS, roots: { ...DEFAULTS.roots } };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return { ...DEFAULTS, ...raw, roots: { ...DEFAULTS.roots, ...(raw.roots ?? {}) } };
  } catch {
    return { ...DEFAULTS, roots: { ...DEFAULTS.roots } };
  }
}

const abs = (root, rel) => (isAbsolute(rel) ? rel : resolve(root, rel));

export function paths(root, cfg) {
  const pshedDir = abs(root, cfg.roots.pshed);
  const wikiDir = abs(root, cfg.roots.wiki);
  const observeDir = join(root, '.pobserve');
  return {
    pshedDir,
    pshedLogsDir: join(pshedDir, 'logs'),
    pshedRunDir: join(pshedDir, 'run'),
    pshedStateDir: join(pshedDir, 'state'),
    pshedJobs: join(pshedDir, 'jobs.yml'),
    tasksFile: abs(root, cfg.roots.ptasks),
    graphDb: abs(root, cfg.roots.pgraph),
    wikiDir,
    wikiPagesDir: join(wikiDir, 'pages'),
    wikiRawDir: join(wikiDir, 'raw'),
    wikiIndexJson: join(wikiDir, 'index.json'),
    pwikiConfig: join(wikiDir, '.pwiki.json'),
    observeDir,
    journalDir: observeDir,
    journalFile: join(observeDir, 'events.jsonl'),
  };
}

export function detectPlugins(root, cfg) {
  const p = paths(root, cfg);
  return {
    pshed: existsSync(p.pshedDir),
    ptasks: existsSync(p.tasksFile),
    pgraph: existsSync(p.graphDb),
    wiki: existsSync(p.wikiDir),
  };
}
