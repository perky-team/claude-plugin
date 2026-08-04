import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-shadow-')); });
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

// Go 1.21 added the builtins `min` and `max`, so any repo that still supports an
// older Go declares its own. `new`, `copy`, `delete`, `clear`, `close`, `print`,
// `println`, `cap` and `len` are all legal package-level names too. A package
// declaration shadows the builtin — Go's own scoping rule — so a plain call in
// that package means the repo function, not the builtin.
describe('a Go function that shadows a builtin', () => {
  it('answers calls to it, certainly, from the same package', async () => {
    write('main.go', `package main

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clamp(v, hi int) int { return max(v, hi) }

func widest(xs []int) int {
	w := 0
	for _, x := range xs {
		w = max(w, x)
	}
	return w
}
`);
    const store = await indexed();

    // Both call sites sit in the same file as the declaration. Marking them
    // "external" made the edge unresolvable by every pass, and the gap report
    // then counted them as calls that left the repo.
    expect(store.callers('main.max').map((n) => n.qname).sort())
      .toEqual(['main.clamp', 'main.widest']);
    // Go decides this by its scoping rule, not by a name coincidence, so the
    // rows must be certain — `impact` refuses to follow a guess.
    expect(store.callers('main.max').every((r) => r.guess === 0)).toBe(true);
    expect(store.impact('main.max').map((n) => n.qname).sort())
      .toEqual(['main.clamp', 'main.widest']);
    // Nothing is left over to report as a missing call site.
    expect(store.gapsFor('main.max')).toEqual([]);

    store.close();
  }, 30000);

  it('still treats the real builtin as external when no package declares it', async () => {
    write('main.go', `package main

func widest(xs []int) int {
	w := 0
	for _, x := range xs {
		w = max(w, x)
	}
	return len(xs) + w
}
`);
    const store = await indexed();

    // Nothing in this repo is named max or len, so both calls really do leave
    // it. They must stay unresolved and stay counted as external.
    const gaps = store.gapsFrom('main.widest');
    expect(gaps.map((g) => g.dst_name).sort()).toEqual(['len', 'max']);
    expect(gaps.every((g) => g.reason === 'external')).toBe(true);

    store.close();
  }, 30000);

  it('does not let one package\'s shadow answer another package\'s builtin call', async () => {
    write('mathx/mathx.go', `package mathx

func max(a, b int) int { return a }
func Use(a, b int) int { return max(a, b) }
`);
    write('other/other.go', `package other

func Widest(a, b int) int { return max(a, b) }
`);
    const store = await indexed();

    // `mathx.max` is not in scope in package `other`, so that call really is
    // the builtin. Only the same-package caller may link.
    expect(store.callers('mathx.max').map((n) => n.qname)).toEqual(['mathx.Use']);

    store.close();
  }, 30000);

  it('refuses to pick when two files of the package declare the same name', async () => {
    // Two build-tagged files of one package, each declaring `max`. p-graph does
    // not evaluate build tags, so it sees two candidates and must not guess.
    write('plat/a.go', `//go:build linux

package plat

func max(a, b int) int { return a }
func UseA(a, b int) int { return max(a, b) }
`);
    write('plat/b.go', `//go:build windows

package plat

func max(a, b int) int { return b }
`);
    const store = await indexed();

    // Two nodes carry the qname plat.max, so no call may be linked to either.
    expect(store.callers('plat.max')).toEqual([]);

    store.close();
  }, 30000);
});
