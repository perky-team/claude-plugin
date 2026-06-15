import { openStore } from './destinations/local-sqlite.mjs';

export function resolveDestination(cfg, dbPath) {
  const kind = cfg?.destination ?? 'local';
  if (kind === 'local') return openStore(dbPath);
  throw new Error(`unknown destination: ${kind}`);
}
