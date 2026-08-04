import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from './vendor/js-yaml.mjs';

export function paths(root) {
  const dir = join(root, '.pshed');
  return {
    dir,
    jobs: join(dir, 'jobs.yml'),
    config: join(dir, 'config.json'),
    stateDir: join(dir, 'state'),
    logsDir: join(dir, 'logs'),
    runDir: join(dir, 'run'),
  };
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function readJobs(root) {
  const p = paths(root).jobs;
  if (!existsSync(p)) return { version: 1, defaults: {}, jobs: [], profiles: {} };
  const data = yaml.load(readFileSync(p, 'utf-8')) || {};
  return { version: data.version ?? 1, defaults: data.defaults ?? {}, jobs: data.jobs ?? [], profiles: data.profiles ?? {} };
}

export function writeJobs(root, data) {
  // The speed-profile table has to survive the round trip. setJob/rmJob write back
  // exactly the object readJobs handed them, so a key dropped on either side is a key
  // deleted from the operator's file by the next `set-job` — silently.
  const { profiles, ...rest } = data;
  const out = profiles && Object.keys(profiles).length ? { ...rest, profiles } : rest;
  writeFile(paths(root).jobs, yaml.dump(out));
}

export function readConfig(root) {
  const p = paths(root).config;
  const base = { nodeBin: 'node', claudeBin: 'claude' };
  if (!existsSync(p)) return base;
  try {
    return { ...base, ...JSON.parse(readFileSync(p, 'utf-8')) };
  } catch {
    return base;
  }
}

export function readJobState(root, id) {
  const p = join(paths(root).stateDir, `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch { return null; } // corrupt/truncated (e.g. killed mid-write) -> treat as no state
}

export function writeJobState(root, id, st) {
  writeFile(join(paths(root).stateDir, `${id}.json`), JSON.stringify(st, null, 2) + '\n');
}

export function removeJobState(root, id) {
  rmSync(join(paths(root).stateDir, `${id}.json`), { force: true });
}

export function listStateIds(root) {
  const dir = paths(root).stateDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(.+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Aggregate view (tolerant of corrupt files), used for reads/asserts.
export function readState(root) {
  const jobs = {};
  for (const id of listStateIds(root)) {
    const st = readJobState(root, id);
    if (st) jobs[id] = st;
  }
  return { jobs };
}
