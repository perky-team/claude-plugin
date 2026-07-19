import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPgraphAdapter, buildStatusCommand } from '../lib/adapters/pgraph.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-pgraph-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedDb(p: any) { mkdirSync(dirname(p.graphDb), { recursive: true }); writeFileSync(p.graphDb, 'x'); }

describe('pgraph adapter with counts', () => {
  it('emits index.refresh with deltas and drift.warn', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg); seedDb(p);
    const events: any[] = [];
    let counts = { nodes: 100, edges: 40, files: 5, drift: 0, schema_version: 3, indexed_sha: 'aaa' };
    const a = createPgraphAdapter({ root, paths: p, cfg, emit: (e) => events.push(e), runStatus: () => counts });
    a.backfill(); // seeds baseline, no event
    counts = { ...counts, nodes: 118, drift: 2 };
    a._onChange();
    expect(events.map((e) => e.kind)).toEqual(['index.refresh', 'drift.warn']);
    expect(events[0].summary).toMatch(/\+18 nodes/);
    expect(events[1].severity).toBe('warn');
  });
});

describe('pgraph adapter degraded (no pgraphCli)', () => {
  it('emits a coarse mtime-only index.refresh', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg); seedDb(p);
    const events: any[] = [];
    const a = createPgraphAdapter({ root, paths: p, cfg, emit: (e) => events.push(e), runStatus: () => null });
    a._onChange();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'index.refresh', summary: 'db changed' });
  });
});

describe('pgraph adapter change-guarding (no no-op spam)', () => {
  function mk(getCounts: () => any) {
    const cfg = loadConfig(root); const p = paths(root, cfg); seedDb(p);
    const events: any[] = [];
    const a = createPgraphAdapter({ root, paths: p, cfg, emit: (e) => events.push(e), runStatus: () => getCounts() });
    return { a, events };
  }

  it('emits index.refresh once on first observation, then stays silent for unchanged counts', () => {
    const counts = { nodes: 65, edges: 20, files: 5, drift: 0 };
    const { a, events } = mk(() => counts);
    a._onChange();
    a._onChange();
    expect(events.filter((e) => e.kind === 'index.refresh')).toHaveLength(1);
  });

  it('emits exactly one index.refresh with the delta when the node count changes', () => {
    let counts = { nodes: 65, edges: 20, files: 5, drift: 0 };
    const { a, events } = mk(() => counts);
    a._onChange(); // first observation
    a._onChange(); // unchanged — silent
    counts = { ...counts, nodes: 70 };
    a._onChange(); // +5
    const refreshes = events.filter((e) => e.kind === 'index.refresh');
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1].summary).toMatch(/\+5 nodes/);
  });

  it('emits drift.warn only when the drift count changes, and never after it clears', () => {
    let counts = { nodes: 65, edges: 20, files: 5, drift: 3 };
    const { a, events } = mk(() => counts);
    a._onChange();                       // drift 3 -> one warn
    a._onChange();                       // drift 3 unchanged -> silent
    counts = { ...counts, drift: 5 };
    a._onChange();                       // drift 5 -> one warn
    counts = { ...counts, drift: 0 };
    a._onChange();                       // cleared -> no warn
    a._onChange();                       // still 0 -> no warn
    expect(events.filter((e) => e.kind === 'drift.warn').map((e) => e.summary))
      .toEqual(['drift 3 files', 'drift 5 files']);
  });

  it('emits the degraded "db changed" event only on entry into the error state', () => {
    const { a, events } = mk(() => null);
    a._onChange();
    a._onChange();
    a._onChange();
    expect(events.filter((e) => e.summary === 'db changed')).toHaveLength(1);
  });
});

describe('defaultRunStatus invocation is read-only', () => {
  it('disables p-graph autorefresh via env and --stale-ok so status never writes the db', () => {
    const cmd = buildStatusCommand({ nodeBin: 'node', pgraphCli: '/plugins/p-graph/tools/pgraph.mjs' });
    expect(cmd.file).toBe('node');
    expect(cmd.args).toEqual(['/plugins/p-graph/tools/pgraph.mjs', 'status', '--json', '--stale-ok']);
    expect(cmd.options.env.PGRAPH_AUTOREFRESH).toBe('0');
  });
});
