import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths, detectPlugins } from '../lib/config.mjs';
import { buildAdapters, runBackfill, collectStatus } from '../lib/core.mjs';
import { createBus } from '../lib/bus.mjs';
import { appendJournal, replayJournal } from '../lib/journal.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-core-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('runBackfill', () => {
  it('prefers the journal when present', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    appendJournal(p.journalDir, { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} }, Date.now());
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

  it('does not write the journal (only emits)', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    const e1 = { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} };
    const e2 = { ts: 2, plugin: 'p-shed', kind: 'job.finished', entity: 'b', severity: 'ok', summary: 'y', data: {} };
    appendJournal(p.journalDir, e1, Date.now());
    appendJournal(p.journalDir, e2, Date.now());
    const adapters = buildAdapters({ root, cfg, paths: p, detected: { pshed: false, ptasks: false, pgraph: false, wiki: false }, emit: () => {} });
    const events: any[] = [];
    runBackfill(adapters, { paths: p, cfg, emit: (e) => events.push(e) });
    expect(events).toHaveLength(2);
    expect(replayJournal(p.journalDir)).toHaveLength(2);
  });

  it('does not self-amplify the journal across the CLI subscribe ordering', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    const e1 = { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} };
    const e2 = { ts: 2, plugin: 'p-shed', kind: 'job.finished', entity: 'b', severity: 'ok', summary: 'y', data: {} };
    appendJournal(p.journalDir, e1, Date.now());
    appendJournal(p.journalDir, e2, Date.now());
    const adapters = buildAdapters({ root, cfg, paths: p, detected: { pshed: false, ptasks: false, pgraph: false, wiki: false }, emit: () => {} });
    const bus = createBus({ size: 500 });
    // Journal subscriber NOT yet attached: replay must not be re-appended.
    runBackfill(adapters, { paths: p, cfg, emit: bus.push });
    // Now attach the journal subscriber, matching the fixed CLI ordering.
    bus.subscribe((e) => appendJournal(p.journalDir, e, Date.now()));
    const live = { ts: 3, plugin: 'p-shed', kind: 'job.finished', entity: 'c', severity: 'ok', summary: 'z', data: {} };
    bus.push(live);
    expect(replayJournal(p.journalDir)).toHaveLength(3);
  });

  it('always seeds adapters even when a journal is present', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    appendJournal(p.journalDir, { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} }, Date.now());
    const stub = { backfill: vi.fn(), start() {}, stop() {}, status() { return {}; } };
    const adapters = { pshed: stub };
    const events: any[] = [];
    runBackfill(adapters, { paths: p, cfg, emit: (e) => events.push(e) });
    expect(stub.backfill).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
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
