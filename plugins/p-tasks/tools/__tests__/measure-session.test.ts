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
    expect(r.hit_cap).toBe(false);
  });

  // Measured against the real CLI: a probe with --max-budget-usd 0.05 came back
  // with terminal_reason set and a cost of $0.30 — six times the cap, because a
  // turn already in flight still finishes. Believe the field, not the money.
  it('believes the CLI when it says the budget stopped the session', () => {
    const bin = stub(`process.stdout.write(JSON.stringify(
      { total_cost_usd: 0.30, terminal_reason: 'budget_exhausted' }));`);
    expect(runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' }).hit_cap)
      .toBe(true);
  });

  // Measured: a real session spent $0.956 of a $1.00 budget over 26 turns and
  // came back with an ordinary terminal reason. The CLI only says
  // `budget_exhausted` when one turn blows through what is left, not when it
  // stops cleanly at the edge — but the budget ended that session either way.
  it('counts a session that spent nearly all its budget, whatever the CLI called it', () => {
    const bin = stub(`process.stdout.write(JSON.stringify(
      { total_cost_usd: 0.956, terminal_reason: 'end_turn' }));`);
    expect(runSession({ dir, arm: 'none', capUsd: 1, claudeBin: bin, runner: 'node' }).hit_cap)
      .toBe(true);
  });

  it('leaves a session well inside its budget alone', () => {
    const bin = stub(`process.stdout.write(JSON.stringify(
      { total_cost_usd: 0.40, terminal_reason: 'end_turn' }));`);
    expect(runSession({ dir, arm: 'none', capUsd: 1, claudeBin: bin, runner: 'node' }).hit_cap)
      .toBe(false);
  });

  it('still counts one when the CLI reports no terminal reason at all', () => {
    const bin = stub(`process.stdout.write(JSON.stringify({ total_cost_usd: 0.95 }));`);
    expect(runSession({ dir, arm: 'none', capUsd: 1, claudeBin: bin, runner: 'node' }).hit_cap)
      .toBe(true);
  });

  it('records an error instead of throwing when the CLI writes nothing', () => {
    const bin = stub(`process.exit(1);`);
    const r = runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' });
    expect(r.error).toMatch(/exited 1/);
    expect(r.cost_usd).toBeNull();
  });

  it('records an error instead of throwing when the CLI writes something that is not JSON', () => {
    const bin = stub(`process.stdout.write('not json at all');`);
    const r = runSession({ dir, arm: 'none', capUsd: 5, claudeBin: bin, runner: 'node' });
    expect(r.error).toMatch(/unreadable output/);
    expect(r.cost_usd).toBeNull();
  });

  it('records an error instead of throwing when the binary does not exist', () => {
    const r = runSession({
      dir, arm: 'none', capUsd: 5, claudeBin: join(dir, 'no-such-file.mjs'), runner: 'node',
    });
    expect(r.error).toBeTruthy();
    expect(r.cost_usd).toBeNull();
  });

  // The other half of the contract. These two are caller mistakes that would
  // otherwise produce ordinary-looking rows for an arm that is not the arm it
  // claims to be, so they must stop the study rather than join it.
  it('throws at once when the ptasks arm has no plugin directory', () => {
    expect(() => runSession({ dir, arm: 'ptasks', capUsd: 5, claudeBin: 'x', runner: 'node' }))
      .toThrow(/pluginDir/);
  });

  it('throws at once when there is no binary to run', () => {
    expect(() => runSession({ dir, arm: 'none', capUsd: 5 })).toThrow(/claudeBin/);
  });
});
