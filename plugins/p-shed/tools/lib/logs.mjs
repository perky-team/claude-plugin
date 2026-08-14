import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

// Every dated log file in the directory, parsed line by line. The tick appends to these
// files while this reads them, so a torn final line is expected and must never be fatal:
// an unparseable line is skipped and counted, and the count is shown on the page.
//
// Reading EVERY file and filtering by `ts` is deliberate. File names are UTC dates
// (`dateStr` above) while schedules fire in local time, so picking files by name would
// silently drop the local end of the window on any machine that is not on UTC.
export function readLogRecords(root, sinceMs) {
  const dir = paths(root).logsDir;
  if (!existsSync(dir)) return { records: [], skippedLines: 0 };
  const records = [];
  let skippedLines = 0;
  let names;
  try { names = readdirSync(dir); } catch { return { records: [], skippedLines: 0 }; }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    let text;
    try { text = readFileSync(join(dir, name), 'utf-8'); }
    catch { skippedLines++; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { skippedLines++; continue; }
      if (!rec || typeof rec.ts !== 'number') { skippedLines++; continue; }
      if (rec.ts < sinceMs) continue;   // outside the window is not a defect
      records.push(rec);
    }
  }
  records.sort((a, b) => a.ts - b.ts);
  return { records, skippedLines };
}
