import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPshedAdapter } from '../lib/adapters/pshed.mjs';

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
