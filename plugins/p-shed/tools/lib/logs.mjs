import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './io.mjs';

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function appendLog(root, record, nowMs) {
  const dir = paths(root).logsDir;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${dateStr(nowMs)}.jsonl`), JSON.stringify(record) + '\n', 'utf-8');
}

export function rotateLogs(root, nowMs, retentionDays = 7) {
  const dir = paths(root).logsDir;
  if (!existsSync(dir)) return [];
  const cutoff = Date.parse(dateStr(nowMs) + 'T00:00:00Z') - retentionDays * 24 * 60 * 60 * 1000;
  const deleted = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
      rmSync(join(dir, name), { force: true });
      deleted.push(name);
    }
  }
  return deleted;
}
