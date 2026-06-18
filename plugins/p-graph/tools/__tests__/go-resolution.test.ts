import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-go-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel, src) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}

describe('go name resolution', () => {
  it('resolves qualified New across packages without false edges from the bare name', async () => {
    write('filesink/sink.go', `package filesink
type Writer struct{}
func New() *int { return nil }
func Make() *int { return New() }
func (w *Writer) rotateOnFill() {}
func roll(w *Writer) { w.rotateOnFill() }
`);
    write('udpsink/sink.go', `package udpsink
func New() *int { return nil }
`);
    write('app/app.go', `package app
import (
\t"fmt"
\t"x/filesink"
\t"x/udpsink"
)
func Boot() {
\tfilesink.New()
\tudpsink.New()
\tfmt.Println("hi")
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Cross-package qualified calls resolve to the right package's New.
    expect(store.callers('filesink.New').map((n) => n.qname).sort())
      .toEqual(['app.Boot', 'filesink.Make']); // app calls it; same-package New() too
    expect(store.callers('udpsink.New').map((n) => n.qname)).toEqual(['app.Boot']);

    // impact (transitive callers) and trace work via the qualified name.
    expect(store.impact('filesink.New').map((n) => n.qname).sort())
      .toEqual(['app.Boot', 'filesink.Make']);
    expect(store.trace('app.Boot', 'filesink.New')).toEqual(['app.Boot', 'filesink.New']);

    // A uniquely-named method still resolves through the bare-name fallback.
    expect(store.callers('rotateOnFill').map((n) => n.qname)).toContain('filesink.roll');

    // External/stdlib calls have no node in the repo — they stay unresolved.
    expect(store.callers('Println')).toEqual([]);
    const resolvedToMissing = store.db
      .prepare(`SELECT count(*) c FROM edges WHERE dst_name = 'fmt.Println' AND dst_id IS NOT NULL`)
      .get().c;
    expect(resolvedToMissing).toBe(0);

    store.close();
  }, 30000);
});
