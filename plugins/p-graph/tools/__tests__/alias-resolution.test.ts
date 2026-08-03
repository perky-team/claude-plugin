import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-alias-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

describe('Go import aliases', () => {
  it('resolves a call written through an import alias', async () => {
    write('internal/bufferpool/pool.go', `package bufferpool
func GetBuffer() []byte { return nil }
`);
    write('markup/goldmark.go', `package goldmark
import bp "x/internal/bufferpool"
func Render() []byte { return bp.GetBuffer() }
`);
    const store = await indexed();

    expect(store.callers('bufferpool.GetBuffer').map((n) => n.qname)).toEqual(['goldmark.Render']);
    expect(store.status().unresolved_calls).toBe(0);
    store.close();
  }, 30000);

  it('still resolves a plain, unaliased import', async () => {
    write('internal/bufferpool/pool.go', `package bufferpool
func GetBuffer() []byte { return nil }
`);
    write('markup/plain.go', `package markup
import "x/internal/bufferpool"
func Render() []byte { return bufferpool.GetBuffer() }
`);
    const store = await indexed();

    expect(store.callers('bufferpool.GetBuffer').map((n) => n.qname)).toEqual(['markup.Render']);
    store.close();
  }, 30000);

  it('reads a local variable that shadows an imported package as the variable', async () => {
    write('config/config.go', `package config
func Load() {}
`);
    write('related/related.go', `package related
import "x/config"
type IndexConfig struct{}
func (c IndexConfig) ToKeywords() {}
func Do() {
	config := IndexConfig{}
	config.ToKeywords()
}
`);
    const store = await indexed();

    // A variable hides a package of the same name, so the variable's type is asked
    // about first. Reading `config` as the imported package instead sent this call
    // to the wrong package and left the real one with no caller at all.
    expect(store.callers('related.IndexConfig.ToKeywords').map((n) => n.qname)).toEqual(['related.Do']);
    // The stored row must not carry the wrong qualifier any more.
    const edge = store.db.prepare(
      `SELECT dst_name, dst_bare, field_key FROM edges WHERE kind = 'call' AND line = 7`).get();
    expect(edge.dst_name).toBe('ToKeywords');
    expect(edge.dst_bare).toBe('ToKeywords');
    expect(edge.field_key).toBe('related.Do#var:config');
    // The package it shadows keeps its own symbols — nothing was moved onto it.
    expect(store.callers('config.Load')).toEqual([]);
    store.close();
  }, 30000);
});
