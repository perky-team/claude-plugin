import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPshedAdapter, readJobsMeta } from '../lib/adapters/pshed.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-pshed-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setup() {
  const cfg = loadConfig(root);
  const p = paths(root, cfg);
  const events: any[] = [];
  const adapter = createPshedAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
  return { cfg, p, events, adapter };
}

describe('pshed adapter backfill', () => {
  it('maps today log records to job.* events', () => {
    const { p, events, adapter } = setup();
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const lines = [
      JSON.stringify({ ts: 1, job: 'daily', exit: 0, durationMs: 42000 }),
      JSON.stringify({ ts: 2, job: 'sync', action: 'skipped', reason: 'prev-run-alive' }),
    ].join('\n') + '\n';
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`), lines);

    adapter.backfill();

    expect(events.map((e) => e.kind)).toEqual(['job.finished', 'job.skipped']);
    expect(events[0]).toMatchObject({ plugin: 'p-shed', entity: 'daily', severity: 'ok' });
    expect(events[1]).toMatchObject({ entity: 'sync', kind: 'job.skipped', severity: 'info' });
  });

  // I3: a reclaim row (`{ ts, job: null, action: 'reclaimed-deploy-pause', reclaimed }`,
  // see p-shed's lib/tick.mjs) has neither `exit` (not a completion) nor a recognised
  // `action` in the skipped/not-due/baselined map. Before p-shed's OWN fix, the row it
  // actually wrote had no `action` field at all (`{ ts, outcome: 'reclaimed-deploy-pause',
  // reclaimed }`) and fell all the way through this adapter's fallback to a phantom
  // `job.launched` for job "-" on every tick that lifted an abandoned deploy pause — a
  // launch event with no job and no launch behind it. This test feeds the adapter the
  // NEW row shape p-shed now actually writes and checks it renders as a distinct,
  // recognisable kind instead of any launch-shaped event.
  it('renders a deploy-pause reclaim distinctly instead of a phantom job.launched', () => {
    const { p, events, adapter } = setup();
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ ts: 5, job: null, action: 'reclaimed-deploy-pause', reclaimed: [{ scope: 'global' }] }) + '\n';
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`), line);

    adapter.backfill();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'deploy.reclaimed', entity: '-', severity: 'warn' });
    expect(events[0].kind).not.toBe('job.launched');
    expect(events[0].summary).toContain('1');
  });

  it('marks a non-zero exit completion as error', () => {
    const { p, events, adapter } = setup();
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`),
      JSON.stringify({ ts: 3, job: 'lint', exit: 1, durationMs: 7000 }) + '\n');
    adapter.backfill();
    expect(events[0]).toMatchObject({ kind: 'job.finished', severity: 'error' });
  });
});

describe('pshed adapter status', () => {
  it('reports running jobs from pidfiles', () => {
    const { p, adapter } = setup();
    mkdirSync(p.pshedRunDir, { recursive: true });
    writeFileSync(join(p.pshedRunDir, 'daily.pid'), '1234');
    expect(adapter.status().running).toContain('daily');
  });
});

describe('pshed adapter run-dir scan', () => {
  it('emits job.launched again when a pidfile reappears after removal', () => {
    const { p, events, adapter } = setup();
    mkdirSync(p.pshedRunDir, { recursive: true });
    // prime prevPids as empty (nothing running at start)
    // first launch:
    writeFileSync(join(p.pshedRunDir, 'daily.pid'), '1');
    adapter._scanRun();
    // run finishes, pidfile removed:
    rmSync(join(p.pshedRunDir, 'daily.pid'), { force: true });
    adapter._scanRun();
    // next scheduled run relaunches:
    writeFileSync(join(p.pshedRunDir, 'daily.pid'), '2');
    adapter._scanRun();
    const launches = events.filter((e) => e.kind === 'job.launched' && e.entity === 'daily');
    expect(launches).toHaveLength(2);
  });
});

const JOBS = `jobs:
  - id: daily
    schedule: '0 9 * * *'
    enabled: true
    prompt: |-
      run the daily digest
      and post it
    model: sonnet
  - id: sync
    schedule: '*/5 * * * *'
    enabled: false
    prompt: sync mirrors
`;

describe('readJobsMeta', () => {
  it('extracts scalar fields and the first prompt line per job', () => {
    const m = readJobsMeta(JOBS);
    expect(m.daily).toMatchObject({ model: 'sonnet', schedule: '0 9 * * *', enabled: 'true', prompt: 'run the daily digest' });
    expect(m.sync).toMatchObject({ model: '', prompt: 'sync mirrors', enabled: 'false' });
  });
});

describe('pshed adapter jobsMeta', () => {
  it('status() exposes jobsMeta parsed from jobs.yml', () => {
    const { p, adapter } = setup();
    mkdirSync(p.pshedDir, { recursive: true });
    writeFileSync(p.pshedJobs, JOBS);
    expect(adapter.status().jobsMeta.daily.model).toBe('sonnet');
  });

  it('keeps the last good jobsMeta on a torn (no trailing newline) write', () => {
    const { p, adapter } = setup();
    mkdirSync(p.pshedDir, { recursive: true });
    writeFileSync(p.pshedJobs, JOBS);
    expect(adapter.status().jobsMeta.daily.model).toBe('sonnet'); // caches good parse
    writeFileSync(p.pshedJobs, 'jobs:\n  - id: daily\n    prompt: |'); // torn, no newline
    expect(adapter.status().jobsMeta.daily.model).toBe('sonnet'); // cached, not clobbered
  });

  it('returns an empty jobsMeta when jobs.yml is absent', () => {
    const { adapter } = setup();
    expect(adapter.status().jobsMeta).toEqual({});
  });
});
