import { openStore } from './destinations/local-sqlite.mjs';

export function resolveDestination(cfg, dbPath, opts = {}) {
  const kind = cfg?.destination ?? 'local';
  if (kind === 'local') return openStore(dbPath, opts);
  throw new Error(`unknown destination: ${kind}`);
}
