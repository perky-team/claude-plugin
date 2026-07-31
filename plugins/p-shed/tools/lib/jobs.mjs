import { readJobs, writeJobs } from './io.mjs';
import { parseCron } from './cron.mjs';

export class ValidationError extends Error {}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'job';
}

function uniqueId(base, jobs) {
  let id = base;
  let n = 2;
  const taken = new Set(jobs.map((j) => j.id));
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

export function setJob(root, spec) {
  const data = readJobs(root);
  const existing = spec.id ? data.jobs.find((j) => j.id === spec.id) : undefined;

  if (!existing) {
    if (!spec.schedule) throw new ValidationError('schedule is required');
    if (!spec.prompt) throw new ValidationError('prompt is required');
  }
  const schedule = spec.schedule ?? existing.schedule;
  try { parseCron(schedule); } catch (e) { throw new ValidationError(`invalid cron: ${e.message}`); }

  if (spec.effort !== undefined && !EFFORT_LEVELS.includes(spec.effort)) {
    throw new ValidationError(`invalid effort: ${spec.effort} (expected one of ${EFFORT_LEVELS.join(', ')})`);
  }

  // guard: a shell command; '' is the documented clear sentinel (--guard "").
  if (spec.guard !== undefined && typeof spec.guard !== 'string') {
    throw new ValidationError('guard must be a string command (use --guard "" to clear)');
  }
  if (spec.guardTimeoutSec !== undefined && (!Number.isFinite(spec.guardTimeoutSec) || spec.guardTimeoutSec <= 0)) {
    throw new ValidationError(`invalid guardTimeoutSec: ${spec.guardTimeoutSec} (expected a positive number)`);
  }

  // concurrencyGroup: a name; '' is the documented clear sentinel
  // (--concurrency-group ""), which stores an explicit null — see below.
  if (spec.concurrencyGroup !== undefined && spec.concurrencyGroup !== null && typeof spec.concurrencyGroup !== 'string') {
    throw new ValidationError('concurrencyGroup must be a string name (use --concurrency-group "" to clear)');
  }
  // Unlike --guard "", clearing does NOT delete the key: an absent field inherits
  // defaults.concurrencyGroup, so deleting it would re-attach the job to the default
  // group. An explicit null is what "this job is unconstrained" has to look like.
  const concurrencyGroup = spec.concurrencyGroup === '' ? null : spec.concurrencyGroup;

  if (existing) {
    Object.assign(existing, pruneUndefined({
      schedule: spec.schedule,
      prompt: spec.prompt,
      enabled: spec.enabled,
      cwd: spec.cwd,
      timeoutSec: spec.timeoutSec,
      permissionMode: spec.permissionMode,
      allowedTools: spec.allowedTools,
      model: spec.model,
      effort: spec.effort,
      maxConsecutiveFailures: spec.maxConsecutiveFailures,
      guard: spec.guard || undefined,          // '' falls through to the delete below
      guardTimeoutSec: spec.guardTimeoutSec,
      concurrencyGroup,
    }));
    // Clearing the guard also clears its timeout — an orphaned guardTimeoutSec is
    // meaningless (an idle timeout with nothing to time out).
    if (spec.guard === '') { delete existing.guard; delete existing.guardTimeoutSec; }
    writeJobs(root, data);
    return { id: existing.id, created: false };
  }

  const id = spec.id ?? uniqueId(slugify(spec.prompt), data.jobs);
  data.jobs.push(pruneUndefined({
    id,
    schedule,
    enabled: spec.enabled ?? true,
    prompt: spec.prompt,
    cwd: spec.cwd,
    timeoutSec: spec.timeoutSec,
    permissionMode: spec.permissionMode,
    allowedTools: spec.allowedTools,
    model: spec.model,
    effort: spec.effort,
    maxConsecutiveFailures: spec.maxConsecutiveFailures,
    guard: spec.guard || undefined,
    guardTimeoutSec: spec.guardTimeoutSec,
    concurrencyGroup,
  }));
  writeJobs(root, data);
  return { id, created: true };
}

export function rmJob(root, id) {
  const data = readJobs(root);
  const before = data.jobs.length;
  data.jobs = data.jobs.filter((j) => j.id !== id);
  if (data.jobs.length === before) return false;
  writeJobs(root, data);
  return true;
}

function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
