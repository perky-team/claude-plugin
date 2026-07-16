import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from './vendor/js-yaml.mjs';

export function paths(root) {
  const dir = join(root, '.pshed');
  return {
    dir,
    jobs: join(dir, 'jobs.yml'),
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
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
  if (!existsSync(p)) return { version: 1, defaults: {}, jobs: [] };
  const data = yaml.load(readFileSync(p, 'utf-8')) || {};
  return { version: data.version ?? 1, defaults: data.defaults ?? {}, jobs: data.jobs ?? [] };
}

export function writeJobs(root, data) {
  writeFile(paths(root).jobs, yaml.dump(data));
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

export function readState(root) {
  const p = paths(root).state;
  if (!existsSync(p)) return { jobs: {} };
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    return { jobs: data.jobs ?? {} };
  } catch {
    return { jobs: {} };
  }
}

export function writeState(root, state) {
  writeFile(paths(root).state, JSON.stringify(state, null, 2) + '\n');
}
