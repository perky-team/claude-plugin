#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobs, readConfig } from './lib/io.mjs';
import { setJob, rmJob, ValidationError } from './lib/jobs.mjs';
import { resetBreaker, writePause, readPause, removePause } from './lib/breaker.mjs';
import { tick as runTick } from './lib/tick.mjs';
import { runJob } from './lib/launch.mjs';
import { runGuard } from './lib/guard.mjs';
import { classifyRun, resolveUsageLimitPattern, truncateOutput } from './lib/classify.mjs';
import { buildInstall, buildRemove, taskName, crontabLine, applyCrontab, planRemoveCron, scanCrontabTaskIds, crontabHasTask } from './lib/scheduler.mjs';
import { writeGlobalPause, removeGlobalPause } from './lib/pause.mjs';
import { listRunningJobs, terminateJobs, readPid, writePid, removePid, isPidAlive } from './lib/pids.mjs';
import { findGroupHolder } from './lib/concurrency.mjs';
import { resolveTarget } from './lib/target.mjs';
import { collectStatus, formatHuman } from './lib/status.mjs';
import { execFileSync } from 'node:child_process';

// The version is read from the plugin manifest, never hardcoded: a release bumps
// plugin.json#version only, so a constant here drifts silently (this one sat at 0.1.0
// while the plugin shipped 0.8.0). The manifest ships in the same copied tree, so the
// relative path holds in the installed plugin cache too. Never throws — a missing
// manifest degrades to 0.0.0 instead of killing an unrelated command.
export function readVersion() {
  try {
    const manifest = new URL('../.claude-plugin/plugin.json', import.meta.url);
    return JSON.parse(readFileSync(manifest, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
    process.stdout.write(`${readVersion()}\n`);
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
      // Duplicate + group guard. `run` used to write no pidfile at all, so a manual
      // run was invisible to the scheduled tick — `pshed run worker` while the
      // scheduled worker was live started a second one in the same working directory.
      // Refuse instead (--force is the debugging escape hatch); this is a refusal, not
      // a queue, exactly like the tick's skip.
      const own = readPid(root, id);
      const ownLive = own != null && isPidAlive(own);
      if (!args.force) {
        if (ownLive) return emitJson({ id, outcome: 'skipped', reason: 'already-running', pid: own }, 0);
        const holder = findGroupHolder({ root, job, jobs, defaults });
        if (holder) return emitJson({ id, outcome: 'skipped-group', group: holder.group, holder: holder.id }, 0);
      }
      // Manual runs respect the guard (--no-guard bypasses for debugging) but stay
      // STATELESS: no counters, no history log — exactly like guardless `run` today.
      if (job.guard && !args['no-guard']) {
        const g = await runGuard({ job, defaults, root });
        if (g.outcome !== 'pass') {
          const raw = truncateOutput(g.out, g.err);
          return emitJson({ id, outcome: `guard-${g.outcome}`, guard: { exit: g.exit, timedOut: g.timedOut, durationMs: g.durationMs, ...(raw ? { raw } : {}) } }, 0);
        }
      }
      // Publish the pidfile for the duration of the run so the tick's duplicate guard
      // and the group guard can see this manual run. A --force run that stepped over a
      // live incumbent leaves the incumbent's pidfile alone: taking it over and then
      // deleting it on exit would strip the guard from a run that is still going.
      const claim = !ownLive;
      const result = await runJob({
        job, defaults, claudeBin: config.claudeBin,
        onSpawn: (p) => { if (p && claim) writePid(root, id, p); },
      });
      if (claim) removePid(root, id);
      // Expose the classification (success | usage_limit | failure) and a truncated
      // output tail instead of dumping the full capture buffers inline.
      const outcome = classifyRun(result.exit, result.out, result.err, resolveUsageLimitPattern(defaults));
      const { out, err, ...rest } = result;
      const raw = truncateOutput(out, err);
      return emitJson({ id, outcome, result: raw ? { ...rest, raw } : rest }, 0);
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
        guard: args.guard,
        guardTimeoutSec: args['guard-timeout-sec'] !== undefined ? Number(args['guard-timeout-sec']) : undefined,
        concurrencyGroup: args['concurrency-group'],
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

    // pause/resume act on the whole scheduler, ONE job (--id), or ONE concurrency group
    // (--group). resolveTarget throws on anything it cannot match, which is the point:
    // `pause --id worker` used to silently ignore the flag and halt everything.
    if (command === 'pause' || command === 'resume') {
      const { defaults, jobs } = readJobs(root);
      const target = resolveTarget({ jobs, defaults, id: args.id, group: args.group });
      const scoped = target ? (target.scope === 'job' ? { id: target.id } : { group: target.group }) : null;

      if (command === 'pause') {
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        if (!target) return emitJson({ action: 'pause', scope: 'global', ...writeGlobalPause(root, { reason }) }, 0);
        // Already-paused jobs are reported apart from the ones this call stopped, and
        // keep their original reason (see writePause).
        const pausedIds = [], alreadyPausedIds = [];
        for (const id of target.ids) {
          (writePause(root, id, { reason, origin: 'operator' }).alreadyPaused ? alreadyPausedIds : pausedIds).push(id);
        }
        return emitJson({ action: 'pause', scope: target.scope, ...scoped, pausedIds, alreadyPausedIds }, 0);
      }

      if (!target) return emitJson({ action: 'resume', scope: 'global', ...removeGlobalPause(root) }, 0);
      const resumedIds = [], notPausedIds = [];
      for (const id of target.ids) {
        const wasPaused = readPause(root, id) != null;
        if (wasPaused) removePause(root, id);
        (wasPaused ? resumedIds : notPausedIds).push(id);
      }
      return emitJson({ action: 'resume', scope: target.scope, ...scoped, resumedIds, notPausedIds }, 0);
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
