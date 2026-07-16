#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobs, readConfig } from './lib/io.mjs';
import { setJob, rmJob, ValidationError } from './lib/jobs.mjs';
import { tick as runTick } from './lib/tick.mjs';
import { runJob } from './lib/launch.mjs';
import { buildInstall, buildRemove, taskName, crontabLine, applyCrontab, removeFromCrontab } from './lib/scheduler.mjs';
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

const KNOWN = ['tick', 'run', 'install-cron', 'remove-cron', 'set-job', 'rm-job'];

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
      return emitJson({ results }, 0);
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
      });
      return emitJson(res, 0);
    }

    if (command === 'rm-job') {
      if (!args.id) return emitJson({ error: { code: 'validation', message: 'rm-job requires --id' } }, 2);
      return emitJson({ id: args.id, removed: rmJob(root, args.id) }, 0);
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
  if (process.platform === 'win32') {
    const { file, args } = command === 'install-cron'
      ? buildInstall({ platform: 'win32', root, nodeBin, toolPath })
      : buildRemove({ platform: 'win32', root });
    execFileSync(file, args, { stdio: 'ignore' });
    return { scheduler: 'schtasks', task: taskName(root), action: command };
  }
  // POSIX crontab
  const marker = `# ${taskName(root)}`;
  let existing = '';
  try { existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8' }); } catch { existing = ''; }
  const next = command === 'install-cron'
    ? applyCrontab(existing, crontabLine({ root, nodeBin, toolPath }), marker)
    : removeFromCrontab(existing, marker) + '\n';
  execFileSync('crontab', ['-'], { input: next });
  return { scheduler: 'crontab', task: taskName(root), action: command };
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) main();
