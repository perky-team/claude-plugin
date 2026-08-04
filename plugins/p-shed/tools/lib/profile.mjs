import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ValidationError, jobFieldError } from './jobs.mjs';

// What a profile is allowed to change. Deliberately small: a profile is a PACE control,
// not a second place to define a job. `prompt`, `cwd`, `guard` and friends stay in
// jobs.yml, where an edit shows up as a reviewable diff.
export const PROFILE_FIELDS = ['schedule', 'model', 'effort', 'timeoutSec', 'enabled'];

// Where the ACTIVE profile value lives. The path is configured in .pshed/config.json —
// which is itself in the repo, and that is fine: it holds a path, and the value it points
// at is what has to live outside the repository the scheduled workload writes to.
// Relative paths resolve against the root like every other path in config.json.
export function profileFilePath(root, config) {
  const p = config?.profileFile;
  if (typeof p !== 'string' || p.length === 0) return null;
  return isAbsolute(p) ? p : resolve(root, p);
}

// First line, trimmed. null for missing / unreadable / empty — never throws: the
// scheduler must not stop because a pace file is absent.
export function readProfileValue(path) {
  try {
    const first = readFileSync(path, 'utf-8').split('\n')[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

// Which profile is active and — just as important for an operator debugging "why is it
// still slow" — WHERE that answer came from:
//   PSHED_PROFILE  ->  contents of config.profileFile  ->  defaults.profile  ->  none
//
// Two distinct failure fields, because they have opposite consequences:
//   problem: 'unknown-name'      the name resolved but the table has no such entry, so
//                                NO overrides are applied.
//   warning: 'file-missing'      the configured file could not be read, so resolution
//            'file-unreadable'   fell through — whatever that yields IS applied.
// Neither ever halts the tick. A stopped loop is a worse failure than a loop running at
// its default pace, so a profile problem is made visible instead of fatal.
export function resolveProfile({ root, jobsData = {}, config = {}, env = process.env } = {}) {
  const table = jobsData.profiles ?? {};
  const decorate = (r) => (r.name && !Object.prototype.hasOwnProperty.call(table, r.name) ? { ...r, problem: 'unknown-name' } : r);

  const fromEnv = typeof env?.PSHED_PROFILE === 'string' ? env.PSHED_PROFILE.trim() : '';
  const file = profileFilePath(root, config);
  const base = file ? { file } : {};

  if (fromEnv) return decorate({ name: fromEnv, source: 'env', ...base });

  let warning;
  if (file) {
    if (!existsSync(file)) {
      warning = 'file-missing';
    } else {
      const value = readProfileValue(file);
      if (value) return decorate({ name: value, source: 'file', ...base });
      // Present but yielding nothing. An empty file is a legitimate "no choice yet" and
      // simply falls through; a file that cannot be read at all is a setup problem worth
      // reporting — and also falls through rather than halting.
      try { readFileSync(file, 'utf-8'); } catch { warning = 'file-unreadable'; }
    }
  }
  const warn = warning ? { warning } : {};

  const fromDefaults = typeof jobsData.defaults?.profile === 'string' ? jobsData.defaults.profile.trim() : '';
  if (fromDefaults) return decorate({ name: fromDefaults, source: 'default', ...base, ...warn });
  return { name: null, source: 'none', ...base, ...warn };
}

// Layer a profile's per-job overrides on top of the jobs, IN MEMORY. jobs.yml is never
// rewritten: it lives inside the repository the loop commits to, so a rewrite would
// dirty that working tree and the loop would eventually commit the pace change as if it
// were its own work.
export function applyProfile(jobs, profiles, name) {
  const entry = name ? profiles?.[name] : null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return jobs;
  return jobs.map((job) => {
    const over = entry[job.id];
    if (!over || typeof over !== 'object' || Array.isArray(over)) return job;
    const patch = {};
    for (const field of PROFILE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(over, field)) continue;
      // Lenient on purpose: this runs inside the tick, where one bad value must cost that
      // field, not the loop. validateProfiles is the strict counterpart, used by the
      // commands a human is watching.
      if (jobFieldError(field, over[field]) === null) patch[field] = over[field];
    }
    return Object.keys(patch).length ? { ...job, ...patch } : job;
  });
}

// Strict counterpart of applyProfile, for the surfaces where a human is reading the
// output (`profile show` / `list` / `set`). An unknown field is an error here and ignored
// there: a silently-dropped `schedul:` typo is exactly the under-pressure failure speed
// profiles exist to prevent, while an older p-shed must still tick against a table
// written by a newer one.
export function validateProfiles(profiles) {
  if (profiles == null) return;
  if (typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new ValidationError('profiles must be a map of profile name -> job id -> overrides');
  }
  for (const [name, entry] of Object.entries(profiles)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`profile ${name}: expected a map of job id -> overrides`);
    }
    for (const [jobId, over] of Object.entries(entry)) {
      if (!over || typeof over !== 'object' || Array.isArray(over)) {
        throw new ValidationError(`profile ${name}, job ${jobId}: expected a map of field -> value`);
      }
      for (const [field, value] of Object.entries(over)) {
        if (!PROFILE_FIELDS.includes(field)) {
          throw new ValidationError(`profile ${name}, job ${jobId}: unknown field ${field} (expected one of ${PROFILE_FIELDS.join(', ')})`);
        }
        const err = jobFieldError(field, value);
        if (err) throw new ValidationError(`profile ${name}, job ${jobId}: ${err}`);
      }
    }
  }
}

// The single seam tick / status / run read through, so `status` can never report a value
// the scheduler will not act on.
export function effectiveJobs({ root, jobsData = {}, config = {}, env = process.env } = {}) {
  const profile = resolveProfile({ root, jobsData, config, env });
  const jobs = jobsData.jobs ?? [];
  return {
    jobs: profile.name && !profile.problem ? applyProfile(jobs, jobsData.profiles ?? {}, profile.name) : jobs,
    profile,
  };
}
