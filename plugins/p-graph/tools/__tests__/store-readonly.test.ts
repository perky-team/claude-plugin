import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

describe('read-only store open', () => {
  let dir, dbPath;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    dbPath = join(dir, 'graph.db');
    writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
    const w = openStore(dbPath);
    await indexFull({ root: dir, store: w, ignorePatterns: [] });
    w.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves queries and rejects writes', () => {
    const ro = openStore(dbPath, { readOnly: true });
    expect(ro.node('foo')).toBeTruthy();
    expect(ro.callers('bar').some((r) => r.name === 'foo')).toBe(true);
    expect(() => ro.setMeta('x', 'y')).toThrow(/read-only/);
    ro.close();
  });
});
