import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath } from '../watch.mjs';

const today = () => new Date().toISOString().slice(0, 10);

function recordToEvent(rec) {
  const job = rec.job ?? '-';
  if (rec.action && rec.action !== 'launched') {
    const kind = { skipped: 'job.skipped', 'not-due': 'job.notdue', baselined: 'job.baselined' }[rec.action];
    if (!kind) return makeEvent('p-shed', 'job.action', job, `${rec.action}`, rec, rec.ts);
    const summary = rec.reason ? `${rec.action} (${rec.reason})` : rec.action;
    return makeEvent('p-shed', kind, job, summary, rec, rec.ts);
  }
  // a completion (has exit) or a launched marker
  if (rec.exit !== undefined) {
    const secs = rec.durationMs != null ? ` (${Math.round(rec.durationMs / 1000)}s)` : '';
    const summary = rec.timedOut ? `TIMEOUT${secs}` : `exit ${rec.exit}${secs}`;
    return makeEvent('p-shed', 'job.finished', job, summary, rec, rec.ts);
  }
  return makeEvent('p-shed', 'job.launched', job, 'launched', rec, rec.ts);
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function createPshedAdapter({ paths, emit }) {
  const offsets = new Map(); // logfile -> lines already emitted
  let watchers = [];

  function emitNewLogLines() {
    const dir = paths.pshedLogsDir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!/\.jsonl$/.test(name)) continue;
      const file = join(dir, name);
      const recs = readLines(file);
      const seen = offsets.get(file) ?? 0;
      for (let i = seen; i < recs.length; i++) emit(recordToEvent(recs[i]));
      offsets.set(file, recs.length);
    }
  }

  return {
    backfill() {
      const file = join(paths.pshedLogsDir, `${today()}.jsonl`);
      for (const rec of readLines(file)) emit(recordToEvent(rec));
      offsets.set(file, readLines(file).length);
    },
    start() {
      if (existsSync(paths.pshedLogsDir)) watchers.push(watchPath(paths.pshedLogsDir, emitNewLogLines));
      if (existsSync(paths.pshedRunDir)) {
        const known = new Set(existsSync(paths.pshedRunDir) ? readdirSync(paths.pshedRunDir) : []);
        watchers.push(watchPath(paths.pshedRunDir, () => {
          for (const name of readdirSync(paths.pshedRunDir)) {
            if (!known.has(name) && /\.pid$/.test(name)) {
              known.add(name);
              emit(makeEvent('p-shed', 'job.launched', name.replace(/\.pid$/, ''), 'launched'));
            }
          }
        }));
      }
    },
    stop() { for (const w of watchers) w.close(); watchers = []; },
    status() {
      const running = existsSync(paths.pshedRunDir)
        ? readdirSync(paths.pshedRunDir).filter((n) => /\.pid$/.test(n)).map((n) => n.replace(/\.pid$/, ''))
        : [];
      const jobs = {};
      if (existsSync(paths.pshedStateDir)) {
        for (const name of readdirSync(paths.pshedStateDir)) {
          const m = /^(.+)\.json$/.exec(name); if (!m) continue;
          try { jobs[m[1]] = { lastExit: JSON.parse(readFileSync(join(paths.pshedStateDir, name), 'utf-8')).lastExit }; } catch { /* skip corrupt */ }
        }
      }
      return { running, jobs };
    },
  };
}
