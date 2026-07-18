import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, detectPlugins, paths } from '../lib/config.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-cfg-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('returns defaults with no config file', () => {
    const c = loadConfig(root);
    expect(c.bufferSize).toBe(500);
    expect(c.journal).toBe(false);
    expect(c.journalRetentionDays).toBe(7);
    expect(c.roots.pgraph).toBe('.pgraph/graph.db');
    expect(c.pgraphCli).toBe(null);
  });
  it('overlays .pobserve.json over defaults', () => {
    writeFileSync(join(root, '.pobserve.json'), JSON.stringify({ bufferSize: 50, pgraphCli: '/x/pgraph.mjs' }));
    const c = loadConfig(root);
    expect(c.bufferSize).toBe(50);
    expect(c.pgraphCli).toBe('/x/pgraph.mjs');
    expect(c.journalRetentionDays).toBe(7); // untouched default preserved
  });
  it('ignores a corrupt config file, falling back to defaults', () => {
    writeFileSync(join(root, '.pobserve.json'), '{ not json');
    expect(loadConfig(root).bufferSize).toBe(500);
  });
});

describe('detectPlugins', () => {
  it('detects only plugins whose roots exist', () => {
    mkdirSync(join(root, '.pshed'));
    mkdirSync(join(root, 'docs', 'wiki'), { recursive: true });
    const d = detectPlugins(root, loadConfig(root));
    expect(d).toEqual({ pshed: true, ptasks: false, pgraph: false, wiki: true });
  });
});

describe('paths', () => {
  it('resolves absolute targets', () => {
    const p = paths(root, loadConfig(root));
    expect(p.tasksFile).toBe(join(root, 'docs/tasks/tasks.yml'));
    expect(p.graphDb).toBe(join(root, '.pgraph/graph.db'));
    expect(p.journalDir).toBe(join(root, '.pobserve'));
  });
});
