import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('full index', () => {
  it('indexes supported files and skips ignored dirs', async () => {
    writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'skip.ts'), 'function nope() {}');
    const store = openStore(':memory:');
    const res = await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(res.files).toBe(1);
    expect(store.node('foo')).toBeTruthy();
    expect(store.node('nope')).toBeNull();
    expect(store.callees('foo').map((x) => x.name)).toContain('bar');
    store.close();
  }, 30000);

  it('drops symbols of files deleted since the last full index, keeps meta', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}');
    writeFileSync(join(dir, 'b.ts'), 'export function beta() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.node('beta')).toBeTruthy();

    rmSync(join(dir, 'b.ts'));
    const res = await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(res.files).toBe(1);
    expect(store.node('beta')).toBeNull();
    expect(store.node('alpha')).toBeTruthy();
    expect(store.status().files).toBe(1);
    // clear() must not wipe meta
    expect(store.getMeta('schema_version')).not.toBeNull();
    store.close();
  }, 30000);

  it('indexes a Go grouped type() block as whole-file nodes, not a dropped file', async () => {
    writeFileSync(join(dir, 'core.go'), `package core
type (
	PipelineDoneError struct{ msg string }
	InvalidActionError struct{ msg string }
)
func (e *PipelineDoneError) Error() string { return e.msg }
`);
    const store = openStore(':memory:');
    const res = await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(res.files).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.errored).toEqual([]);     // was previously dropped via an undefined-bind throw
    expect(res.zeroNode).toEqual([]);
    expect(store.node('core.PipelineDoneError')).toBeTruthy();
    expect(store.node('core.InvalidActionError')).toBeTruthy();
    expect(store.node('core.PipelineDoneError.Error')).toBeTruthy();
    store.close();
  }, 30000);

  it('reports files that produced zero nodes so a whole-file gap is visible', async () => {
    writeFileSync(join(dir, 'empty.go'), 'package empty\n');   // no top-level symbols
    writeFileSync(join(dir, 'real.go'), 'package real\nfunc Foo() {}\n');
    const store = openStore(':memory:');
    const res = await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(res.zeroNode).toContain('empty.go');
    expect(res.zeroNode).not.toContain('real.go');
    store.close();
  }, 30000);
});
