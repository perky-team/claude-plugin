import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function appendJournal(journalFile, event) {
  mkdirSync(dirname(journalFile), { recursive: true });
  appendFileSync(journalFile, JSON.stringify(event) + '\n', 'utf-8');
}

export function replayJournal(journalFile) {
  if (!existsSync(journalFile)) return [];
  return readFileSync(journalFile, 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
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
