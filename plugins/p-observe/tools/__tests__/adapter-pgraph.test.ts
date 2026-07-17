import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPgraphAdapter } from '../lib/adapters/pgraph.mjs';

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
