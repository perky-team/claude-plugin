import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths, detectPlugins } from '../lib/config.mjs';
import { buildAdapters, runBackfill, collectStatus } from '../lib/core.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-core-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('runBackfill', () => {
  it('prefers the journal when present', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.journalDir, { recursive: true });
    writeFileSync(p.journalFile, JSON.stringify({ ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} }) + '\n');
    const events: any[] = [];
    const adapters = buildAdapters({ root, cfg, paths: p, detected: { pshed: false, ptasks: false, pgraph: false, wiki: false }, emit: (e) => events.push(e) });
    runBackfill(adapters, { paths: p, cfg, emit: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    expect(events[0].entity).toBe('a');
  });

  it('falls back to adapter backfill when no journal', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.pshedLogsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(p.pshedLogsDir, `${today}.jsonl`), JSON.stringify({ ts: 1, job: 'daily', exit: 0 }) + '\n');
    const detected = detectPlugins(root, cfg);
    const events: any[] = [];
    const adapters = buildAdapters({ root, cfg, paths: p, detected, emit: (e) => events.push(e) });
    runBackfill(adapters, { paths: p, cfg, emit: (e) => events.push(e) });
    expect(events.map((e) => e.kind)).toContain('job.finished');
  });
});

describe('collectStatus', () => {
  it('keys each adapter status by plugin', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.pshedRunDir, { recursive: true });
    writeFileSync(join(p.pshedRunDir, 'daily.pid'), '1');
    const adapters = buildAdapters({ root, cfg, paths: p, detected: { pshed: true, ptasks: false, pgraph: false, wiki: false }, emit: () => {} });
    expect(collectStatus(adapters).pshed.running).toContain('daily');
  });
});
