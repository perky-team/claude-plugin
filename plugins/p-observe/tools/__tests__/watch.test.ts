import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeRead, watchPath } from '../lib/watch.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-watch-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('safeRead', () => {
  it('returns parsed value on success', () => {
    const f = join(root, 'a.json'); writeFileSync(f, '{"x":1}');
    expect(safeRead(f, JSON.parse)).toEqual({ ok: true, value: { x: 1 } });
  });
  it('returns {ok:false} on a missing file', () => {
    expect(safeRead(join(root, 'nope'), JSON.parse)).toEqual({ ok: false });
  });
  it('returns {ok:false} on a parse throw (torn read)', () => {
    const f = join(root, 'b.json'); writeFileSync(f, '{ half-writ');
    expect(safeRead(f, JSON.parse)).toEqual({ ok: false });
  });
});

describe('watchPath', () => {
  it('debounces a burst of writes into a single onChange', async () => {
    let calls = 0;
    const w = watchPath(root, () => { calls++; }, { debounceMs: 40 });
    writeFileSync(join(root, 'f1'), 'a');
    writeFileSync(join(root, 'f1'), 'b');
    writeFileSync(join(root, 'f2'), 'c');
    await new Promise((r) => setTimeout(r, 120));
    w.close();
    expect(calls).toBe(1);
  });
});
