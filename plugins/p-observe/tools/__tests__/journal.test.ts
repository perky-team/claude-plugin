import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, replayJournal } from '../lib/journal.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pobs-jrnl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('journal round-trip', () => {
  it('append then replay returns equal events, skipping junk lines', () => {
    const file = join(dir, 'events.jsonl');
    const e1 = { ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'a', severity: 'ok', summary: 'x', data: {} };
    const e2 = { ts: 2, plugin: 'p-tasks', kind: 'task.status', entity: 'T', severity: 'info', summary: 'y', data: {} };
    appendJournal(file, e1); appendJournal(file, e2);
    // corrupt trailing line tolerated
    appendFileSync(file, '{ half\n');
    expect(replayJournal(file)).toEqual([e1, e2]);
  });
  it('replay returns [] when the file is absent', () => {
    expect(replayJournal(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});
