import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT, runSession } from '../../scripts/measure-tracker/session.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const stub = (body: string) => {
  const p = join(dir, 'fake-claude.mjs');
  writeFileSync(p, body);
  return p;
};

describe('PROMPT', () => {
  it('says nothing about what has already been done', () => {
    expect(PROMPT).toBe('Continue the work on the feature described in SPEC.md.');
  });
});

describe('runSession', () => {
  it('records cost and turns from the CLI envelope', () => {
    const bin = stub(`process.stdout.write(JSON.stringify(
      { total_cost_usd: 0.42, num_turns: 7, session_id: 'abc' }));`);
    const r = runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' });
    expect(r.cost_usd).toBe(0.42);
    expect(r.num_turns).toBe(7);
    expect(r.session_id).toBe('abc');
    expect(r.error).toBeNull();
  });

  it('marks a session that spent its whole cap', () => {
    const bin = stub(`process.stdout.write(JSON.stringify({ total_cost_usd: 4.95 }));`);
    expect(runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' }).hit_cap)
      .toBe(true);
  });

  it('records an error instead of throwing when the CLI writes nothing', () => {
    const bin = stub(`process.exit(1);`);
    const r = runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' });
    expect(r.error).toMatch(/exited 1/);
    expect(r.cost_usd).toBeNull();
  });
});
