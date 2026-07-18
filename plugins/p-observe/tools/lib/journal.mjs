import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function appendJournal(journalDir, event, nowMs) {
  mkdirSync(journalDir, { recursive: true });
  appendFileSync(join(journalDir, `${dateStr(nowMs)}.jsonl`), JSON.stringify(event) + '\n', 'utf-8');
}

// Reads every dated journal file in journalDir (ascending by name -> chronological),
// concatenating their events. Returns [] when the dir is absent.
export function replayJournal(journalDir) {
  if (!existsSync(journalDir)) return [];
  const files = readdirSync(journalDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const events = [];
  for (const name of files) {
    const lines = readFileSync(join(journalDir, name), 'utf-8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { events.push(JSON.parse(l)); } catch { /* skip unparseable (torn write) */ }
    }
  }
  return events;
}

// Deletes dated archive files (YYYY-MM-DD.jsonl) older than retentionDays.
export function rotateJournal(journalDir, nowMs, retentionDays = 7) {
  if (!existsSync(journalDir)) return [];
  const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
  const cutoff = Date.parse(dayStr(nowMs) + 'T00:00:00Z') - retentionDays * 86400000;
  const deleted = [];
  for (const name of readdirSync(journalDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) { rmSync(join(journalDir, name), { force: true }); deleted.push(name); }
  }
  return deleted;
}
