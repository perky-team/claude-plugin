import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const GO = `package api
import (
	"bytes"
	"fmt"
)
type W struct {
	sync.Mutex
	Base
	buf bytes.Buffer
}
func (w *W) Do() {
	n := copy(w.b, w.a)
	_ = float64(n)
	fmt.Println(n)
	w.helper()
}
func (w *W) helper() {}
`;

const run = (file, source) => {
  const cfg = resolveLang(file);
  return extract({ file, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
};

describe('edge facts recorded at extraction', () => {
  it('records the bare name of every call target', async () => {
    const { edges } = await run('api.go', GO);
    const byBare = Object.fromEntries(
      edges.filter((e) => e.kind === 'call').map((e) => [e.dst_name, e.dst_bare]));
    expect(byBare['fmt.Println']).toBe('Println');   // package selector
    expect(byBare['api.W.helper']).toBe('helper');   // own receiver
    expect(byBare['copy']).toBe('copy');             // already bare
  }, 20000);

  it('marks a Go builtin call and a predeclared-type conversion as external', async () => {
    const { edges } = await run('api.go', GO);
    const call = (name) => edges.find((e) => e.kind === 'call' && e.dst_name === name);
    expect(call('copy').external).toBe(1);
    expect(call('api.float64').external).toBe(1);
    // A call into an imported package is not marked here: at extraction we cannot
    // tell a third-party package from one that lives in this repo. That is decided
    // at query time, by whether any repo symbol shares the bare name.
    expect(call('fmt.Println').external).toBe(0);
    expect(call('api.W.helper').external).toBe(0);
  }, 20000);

  it('stamps every edge with the language of its file', async () => {
    const { edges } = await run('api.go', GO);
    expect(edges.every((e) => e.lang === 'go')).toBe(true);
    const ts = await run('a.ts', 'class C { run() { this.go(); } go() {} }');
    expect(ts.edges.every((e) => e.lang === 'ts')).toBe(true);
  }, 20000);

  it('records what a Go struct embeds, separately from its named fields', async () => {
    const { fieldTypes } = await run('api.go', GO);
    const embeds = fieldTypes.filter((f) => f.key === 'api.W#embed').map((f) => f.type).sort();
    expect(embeds).toEqual(['api.Base', 'sync.Mutex']);
    // named fields keep their own keys
    expect(fieldTypes.find((f) => f.key === 'api.W.buf')?.type).toBe('bytes.Buffer');
  }, 20000);
});
