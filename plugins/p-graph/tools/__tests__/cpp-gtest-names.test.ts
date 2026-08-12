import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-gtest-')); });
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
const qnames = async (source) => {
  const cfg = resolveLang('s.cc');
  const { nodes } = await extract({
    file: 's.cc', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
  return nodes.map((n) => n.qname);
};

// A googletest body is written `TEST(Suite, Name) { … }`, and tree-sitter reads it
// as a function definition called `TEST`. Measured on leveldb: 139 definitions
// shared the single qname `leveldb.TEST_F` and 47 shared `leveldb.TEST`. Two
// costs. A reader gets rows and gap lines that say `leveldb.TEST_F -> Put` over
// and over with no way to tell which test is meant. And an exact-qname lookup for
// any of them is ambiguous, so it resolves to none of them.
describe('a googletest body is named after its suite and its test', () => {
  it('names TEST and TEST_F from their two arguments', async () => {
    expect(await qnames(`namespace leveldb {
TEST(WriteBatchTest, Empty) { int x = 1; }
TEST_F(CorruptionTest, Recovery) { int y = 2; }
}
`)).toEqual(expect.arrayContaining(['leveldb.WriteBatchTest.Empty', 'leveldb.CorruptionTest.Recovery']));
  }, 30000);

  it('covers the parameterised and typed macros too', async () => {
    const qs = await qnames(`TEST_P(ParamTest, Works) { int a = 1; }
TYPED_TEST(TypedTest, Works) { int b = 2; }
TYPED_TEST_P(TypedSuite, Works) { int c = 3; }
`);
    expect(qs).toContain('ParamTest.Works');
    expect(qs).toContain('TypedTest.Works');
    expect(qs).toContain('TypedSuite.Works');
  }, 30000);

  it('gives every test in a file its own qname', async () => {
    write('db/a_test.cc', `namespace leveldb {
TEST(BatchTest, One) { int a = 1; }
TEST(BatchTest, Two) { int b = 2; }
TEST(OtherTest, One) { int c = 3; }
}
`);
    const store = await indexed();

    const dupes = store.db.prepare(`SELECT qname, COUNT(*) c FROM nodes
      WHERE lang='cpp' GROUP BY qname HAVING c > 1`).all();
    expect(dupes).toEqual([]);
    expect(store.node('leveldb.BatchTest.One')).toBeTruthy();
    expect(store.node('leveldb.BatchTest.Two')).toBeTruthy();
    expect(store.node('leveldb.OtherTest.One')).toBeTruthy();
    store.close();
  }, 30000);

  it('names the caller of a call written inside a test', async () => {
    write('db/b_test.cc', `namespace leveldb {
void Helper() {}
TEST(HelperTest, Runs) { Helper(); }
}
`);
    const store = await indexed();

    expect(store.callers('leveldb.Helper').map((n) => n.qname)).toEqual(['leveldb.HelperTest.Runs']);
    store.close();
  }, 30000);

  // A macro this rule does not know must be left exactly as it was: reading two
  // arguments out of an unknown macro would invent a name.
  it('leaves a macro it does not know alone', async () => {
    expect(await qnames(`MY_OWN_MACRO(Alpha, Beta) { int x = 1; }
`)).toContain('MY_OWN_MACRO');
  }, 30000);

  // A real function called TEST, with a body and ordinary parameters, is not a
  // googletest body. Two typed parameters are what tells them apart.
  it('leaves a real function alone even when it is called TEST', async () => {
    expect(await qnames(`int TEST(int a, int b) { return a + b; }
`)).toContain('TEST');
  }, 30000);
});
