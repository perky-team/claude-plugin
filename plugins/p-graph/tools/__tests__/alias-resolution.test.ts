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

  it('leaves a call on a local variable that shadows an imported package unresolved', async () => {
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

    // `config` is a local variable here, but the graph cannot know that — it sees
    // an identifier that names an imported package. Recording the call as
    // config.ToKeywords is wrong-but-honest: no edge is created, and Task 5's gap
    // report finds it by the bare name instead.
    expect(store.callers('related.IndexConfig.ToKeywords')).toEqual([]);
    const edge = store.db.prepare(
      `SELECT dst_name, dst_bare FROM edges WHERE kind = 'call' AND line = 7`).get();
    expect(edge.dst_name).toBe('config.ToKeywords');
    expect(edge.dst_bare).toBe('ToKeywords');
    store.close();
  }, 30000);
});
