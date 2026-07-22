#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobs, readConfig } from './lib/io.mjs';
import { setJob, rmJob, ValidationError } from './lib/jobs.mjs';
import { resetBreaker } from './lib/breaker.mjs';
import { tick as runTick } from './lib/tick.mjs';
import { runJob } from './lib/launch.mjs';
import { buildInstall, buildRemove, taskName, crontabLine, applyCrontab, planRemoveCron, scanCrontabTaskIds, crontabHasTask } from './lib/scheduler.mjs';
import { writeGlobalPause, removeGlobalPause } from './lib/pause.mjs';
import { listRunningJobs, terminateJobs } from './lib/pids.mjs';
import { collectStatus, formatHuman } from './lib/status.mjs';
import { execFileSync } from 'node:child_process';

export const VERSION = '0.1.0';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[key] = true;
        } else {
          if (key in out) out[key] = [].concat(out[key], next);
          else out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function findRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function emitJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

export function die(message, exitCode = 1) {
  process.stderr.write(message + '\n');
  process.exit(exitCode);
}

const KNOWN = ['tick', 'run', 'install-cron', 'remove-cron', 'set-job', 'rm-job', 'reset-breaker', 'pause', 'resume', 'status', 'stop'];

async function main() {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  const root = findRoot(process.cwd());

  try {
    if (command === 'tick') {
      const results = await runTick({ root, now: Date.now() });
      // Normal ticks return a results array; a globally-paused tick short-circuits with
      // a { action, paused, launched } object which is emitted as-is.
      if (Array.isArray(results)) return emitJson({ results }, 0);
      return emitJson(results, 0);
    }

    if (command === 'run') {
      const id = args._[0];
      if (!id) return emitJson({ error: { code: 'validation', message: 'run <id> requires a job id' } }, 2);
      const { defaults, jobs } = readJobs(root);
      const job = jobs.find((j) => j.id === id);
      if (!job) return emitJson({ error: { code: 'validation', message: `no such job: ${id}` } }, 2);
      const config = readConfig(root);
      const result = await runJob({ job, defaults, claudeBin: config.claudeBin });
      return emitJson({ id, result }, 0);
    }

    if (command === 'set-job') {
      const res = setJob(root, {
        id: args.id, schedule: args.schedule, prompt: args.prompt,
        enabled: args.enabled === undefined ? undefined : args.enabled !== 'false' && args.enabled !== false,
        cwd: args.cwd, timeoutSec: args.timeoutSec ? Number(args.timeoutSec) : undefined,
        permissionMode: args['permission-mode'], allowedTools: args['allowed-tools'],
        model: args.model,
        effort: args.effort,
        maxConsecutiveFailures: args['max-consecutive-failures'] !== undefined ? Number(args['max-consecutive-failures']) : undefined,
      });
      return emitJson(res, 0);
    }

    if (command === 'rm-job') {
      if (!args.id) return emitJson({ error: { code: 'validation', message: 'rm-job requires --id' } }, 2);
      return emitJson({ id: args.id, removed: rmJob(root, args.id) }, 0);
    }

    if (command === 'reset-breaker') {
      const id = args._[0];
      if (!id) return emitJson({ error: { code: 'validation', message: 'reset-breaker <id> requires a job id' } }, 2);
      return emitJson(resetBreaker(root, id), 0);
    }

    if (command === 'pause') {
      const reason = typeof args.reason === 'string' ? args.reason : undefined;
      return emitJson({ action: 'pause', ...writeGlobalPause(root, { reason }) }, 0);
    }

    if (command === 'resume') {
      return emitJson({ action: 'resume', ...removeGlobalPause(root) }, 0);
    }

    if (command === 'status') {
      const status = collectStatus(root, { installed: isTickInstalled(root) });
      if (args.human) { process.stdout.write(formatHuman(status) + '\n'); return process.exit(0); }
      return emitJson(status, 0);
    }

    if (command === 'stop') {
      // stop = honest cron teardown (from remove-cron) + optionally kill in-flight jobs.
      // Distinct from pause: stop tears the scheduler down, pause is a reversible halt.
      const teardown = manageCron('remove-cron', root);
      const out = { ...teardown, action: 'stop' };
      if (args.kill) {
        const graceMs = args['grace-ms'] !== undefined ? Number(args['grace-ms']) : undefined;
        out.killed = await terminateJobs(listRunningJobs(root), { graceMs });
      }
      return emitJson(out, 0);
    }

    if (command === 'install-cron' || command === 'remove-cron') {
      return emitJson(manageCron(command, root), 0);
    }
  } catch (e) {
    if (e instanceof ValidationError) return emitJson({ error: { code: 'validation', message: e.message } }, 2);
    return emitJson({ error: { code: 'internal', message: e?.message ?? String(e) } }, 1);
  }
}

function manageCron(command, root) {
  const nodeBin = process.execPath;
  const toolPath = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? manageCronWin32(command, root, nodeBin, toolPath)
    : manageCronPosix(command, root, nodeBin, toolPath);
}

// The wrong-dir mismatch warning: the folder-scoped task id was not present, so nothing
// was removed. The root-cause of the `remove-cron silently did nothing` incident.
function wrongDirWarning(what, root) {
  return `no ${what} for ${taskName(root)} — nothing removed; run from the repo dir, or the loop may still be installed under a different id`;
}

function manageCronWin32(command, root, nodeBin, toolPath) {
  if (command === 'install-cron') {
    const { file, args } = buildInstall({ platform: 'win32', root, nodeBin, toolPath });
    execFileSync(file, args, { stdio: 'ignore' });
    return { scheduler: 'schtasks', task: taskName(root), action: command, installed: true };
  }
  // remove-cron: schtasks /Delete exits non-zero when the task doesn't exist, so a
  // wrong-dir run reports removed:false instead of masquerading as success.
  const { file, args } = buildRemove({ platform: 'win32', root });
  let removed = false;
  try { execFileSync(file, args, { stdio: 'ignore' }); removed = true; } catch { removed = false; }
  const out = { scheduler: 'schtasks', task: taskName(root), action: command, removed };
  if (!removed) {
    out.warning = wrongDirWarning('scheduled task', root);
    out.installedTaskIds = scanSchtasksTaskIds();
  }
  return out;
}

function manageCronPosix(command, root, nodeBin, toolPath) {
  let existing = '';
  try { existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8' }); } catch { existing = ''; }
  if (command === 'install-cron') {
    const marker = `# ${taskName(root)}`;
    const next = applyCrontab(existing, crontabLine({ root, nodeBin, toolPath }), marker);
    execFileSync('crontab', ['-'], { input: next });
    return { scheduler: 'crontab', task: taskName(root), action: command, installed: true };
  }
  // remove-cron: only rewrite the crontab when a line was actually removed (diff old vs
  // new), so a wrong-dir run never mutates and never conjures an empty crontab — it
  // reports removed:false with the mismatch warning. Also fixes the old trailing-newline
  // that was appended on every call.
  const { next, removed, foundTaskIds } = planRemoveCron(existing, root);
  if (removed) execFileSync('crontab', ['-'], { input: next ? next + '\n' : '' });
  const out = { scheduler: 'crontab', task: taskName(root), action: command, removed };
  if (!removed) {
    out.warning = wrongDirWarning('cron entry', root);
    out.installedTaskIds = foundTaskIds;
  }
  return out;
}

// Best-effort scan of Task Scheduler for any pshed-* task, so a wrong-dir remove/stop on
// Windows can point at the loop that is actually installed. This enumerates every task on
// the machine (schtasks has no name wildcard), so it is capped with a timeout and is
// non-fatal: [] on any error/timeout. CSV/NH keeps the output compact.
function scanSchtasksTaskIds() {
  try {
    return scanCrontabTaskIds(
      execFileSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf-8', timeout: 3000, windowsHide: true }),
    );
  } catch { return []; }
}

// Whether this folder's every-minute tick is registered in the OS scheduler. Read-only
// probe for `status`; false on any error (no crontab, task absent, tool missing). The
// win32 query is by exact task name (no machine-wide enumeration), but still capped.
function isTickInstalled(root) {
  try {
    if (process.platform === 'win32') {
      execFileSync('schtasks', ['/Query', '/TN', taskName(root)], { stdio: 'ignore', timeout: 3000, windowsHide: true });
      return true;
    }
    return crontabHasTask(execFileSync('crontab', ['-l'], { encoding: 'utf-8' }), root);
  } catch { return false; }
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) main();
