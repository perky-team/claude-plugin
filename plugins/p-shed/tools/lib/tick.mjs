import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJobs, readConfig, readState, writeState } from './io.mjs';
import { parseCron, isDue } from './cron.mjs';
import { runJob as realRunJob } from './launch.mjs';
import { appendLog as realAppendLog, rotateLogs as realRotateLogs } from './logs.mjs';

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function writePid(root, id, pid) {
  const dir = paths(root).runDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.pid`), String(pid), 'utf-8');
}

function removePid(root, id) {
  rmSync(join(paths(root).runDir, `${id}.pid`), { force: true });
}

function readPid(root, id) {
  const p = join(paths(root).runDir, `${id}.pid`);
  if (!existsSync(p)) return null;
  const n = parseInt(readFileSync(p, 'utf-8').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

export async function tick({ root, now = Date.now(), deps = {} }) {
  const d = {
    readJobs, readConfig, readState, writeState,
    runJob: realRunJob, appendLog: realAppendLog, rotateLogs: realRotateLogs,
    isPidAlive, writePid: (id, pid) => writePid(root, id, pid), removePid: (id) => removePid(root, id),
    ...deps,
  };

  d.rotateLogs(root, now);
  const { defaults, jobs } = d.readJobs(root);
  const config = d.readConfig(root);
  const state = d.readState(root);
  const results = [];

  for (const job of jobs) {
    if (job.enabled === false) continue;
    const st = state.jobs[job.id];

    if (!st || st.lastRun == null) {
      state.jobs[job.id] = { lastRun: now, lastExit: null, pid: null };
      results.push({ id: job.id, action: 'baselined' });
      continue;
    }

    const pid = readPid(root, job.id) ?? st.pid;
    if (d.isPidAlive(pid)) { results.push({ id: job.id, action: 'skipped' }); continue; }

    if (!isDue(parseCron(job.schedule), st.lastRun, now)) {
      results.push({ id: job.id, action: 'not-due' });
      continue;
    }

    const r = await d.runJob({ job, defaults, claudeBin: config.claudeBin, onSpawn: (pid) => { if (pid) d.writePid(job.id, pid); } });
    state.jobs[job.id] = { lastRun: now, lastExit: r.exit, pid: null };
    d.appendLog(root, { ts: now, job: job.id, exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs }, now);
    d.removePid(job.id);
    results.push({ id: job.id, action: 'launched', exit: r.exit, timedOut: r.timedOut });
  }

  d.writeState(root, state);
  return results;
}
