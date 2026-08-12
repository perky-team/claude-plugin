import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-gaplang-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
const indexed = async () => {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
};

// The gap report matched call sites by name alone, with no language check. On
// re2 — a C++ library with a Python binding — `callers re2.RE2.Match` listed 92
// missing call sites, and seven of the first twenty were Python calls to an
// unrelated `Match`. A call in another language can never be the answer, so
// listing it only makes the banner longer and less believable.
describe('the gap report stays in the target language', () => {
  beforeEach(() => {
    write('src/re.cc', `namespace re {
bool Match(int x) { return x > 0; }
}
bool Use() { return shape::Match(1); }
`);
    write('bind/re.py', `def run(x):
    return x.Match()
`);
  });

  it('does not list a call site written in another language', async () => {
    const store = await indexed();

    const files = store.gapsFor('re.Match').map((g) => g.file);
    expect(files).toContain('src/re.cc');
    expect(files).not.toContain('bind/re.py');
    store.close();
  }, 30000);

  it('the Python symbol still gets its own gap when asked for', async () => {
    // The row is not deleted, only kept out of an answer it cannot belong to.
    // Two Python classes own the name, so the bare-name fallback refuses it and
    // it stays a real gap — one class would simply be guessed and never
    // reach the report at all.
    write('bind/re.py', `class Sink:
    def Match(self):
        return True

class Other:
    def Match(self):
        return False

def run(x):
    return x.Match()
`);
    const store = await indexed();

    const files = store.gapsFor('Sink.Match').map((g) => g.file);
    expect(files).toContain('bind/re.py');
    expect(files).not.toContain('src/re.cc');
    store.close();
  }, 30000);

  it('gapsAround keeps the same rule', async () => {
    const store = await indexed();

    expect(store.gapsAround('re.Match').map((g) => g.file)).not.toContain('bind/re.py');
    store.close();
  }, 30000);

  // A name that several languages share must not lose its own rows either.
  it('keeps every row that is in the target language', async () => {
    write('src/two.cc', `namespace re {
bool Ping(int x) { return true; }
}
bool A() { return shape::Ping(1); }
bool B() { return other::Ping(2); }
`);
    const store = await indexed();

    expect(store.gapsFor('re.Ping').map((g) => `${g.file}:${g.line}`).sort())
      .toEqual(['src/two.cc:4', 'src/two.cc:5']);
    store.close();
  }, 30000);
});
