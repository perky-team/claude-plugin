import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// The same fixture as file-scope-callers.test.ts, asked through the CLI. Both
// `m.eject` calls sit at the module's top level, so their edges hold no caller
// symbol and `callers` could not show them at all. They were named in the gap
// banner instead — one line each, capped at 20 rows.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-filescope-cli-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
  write('lib/manager.js', `export class Manager {
  eject(id) { return id; }
}
`);
  write('app/boot.js', `import { Manager } from '../lib/manager.js';
const m = new Manager();
m.eject(1);
m.eject(2);
`);
  run(['index', '--full']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the printed answer lists a file-scope caller', () => {
  it('lists the file and its call sites in the main list', async () => {
    const text = run(['callers', 'Manager.eject']);
    expect(text).toContain('app/boot.js');
    expect(text).toMatch(/app\/boot\.js\s+3, 4/);
  }, 30000);

  it('does not print a line number for the file itself', async () => {
    // A file has no declaration line. Printing `app/boot.js:null` or `:0` would
    // read as a location the reader could open.
    const text = run(['callers', 'Manager.eject']);
    expect(text).not.toMatch(/boot\.js:(null|undefined|0)\b/);
  }, 30000);

  // `✓ complete` is the strongest claim this plugin makes — the rule reads it as
  // "stop. Do not grep." Before this work the answer listed 17 of axios's 25
  // `eject` call sites and printed `✓ complete`, which was false. Then it listed 17
  // and named 8 under `⚠`, which was true but cost the reader a pass. Now it lists
  // all of them, so the line is both true and free.
  it('says the answer is complete once nothing is missing', async () => {
    const text = run(['callers', 'Manager.eject']);
    expect(text).toContain('✓ complete');
    expect(text).not.toContain('missing from this answer');
    expect(text).not.toContain('outside any indexed symbol');
  }, 30000);

  // `impact X` answers "what breaks if I change X", and a call written at file
  // scope really does break. So it belongs in the answer — as a LEAF: nothing
  // calls a top-level statement, so it ends the reverse walk instead of
  // extending it.
  //
  // It used to print `(no impact)` and then name the two lines under ⚠. The
  // headline was false and the banner rescued it, and `callers` on the same
  // symbol said something else. Both commands now print the same row.
  it('lists the file row in impact too, and says the answer is complete', async () => {
    const text = run(['impact', 'Manager.eject']);
    expect(text).toContain('file app/boot.js');
    expect(text).toMatch(/file app\/boot\.js\s+3, 4/);
    expect(text).not.toContain('(no impact)');
    // A file has no declaration line and no signature, so neither may be faked.
    expect(text).not.toMatch(/boot\.js:(null|undefined|0)\b/);
    expect(text).not.toContain('null');
    expect(text).toContain('✓ complete');
    expect(text).not.toContain('missing from this answer');
    expect(text).not.toContain('outside any indexed symbol');
  }, 30000);

  // The whole point of this work: two commands, one symbol, one answer. They
  // disagreed — `callers` listed the file row and said complete, `impact` said
  // `(no impact)` and then named the lines as missing.
  it('makes callers and impact agree about the same symbol', async () => {
    const callers = run(['callers', 'Manager.eject']);
    const impact = run(['impact', 'Manager.eject']);
    for (const text of [callers, impact]) {
      expect(text).toMatch(/file app\/boot\.js\s+3, 4/);
      expect(text).toContain('✓ complete');
    }
  }, 30000);

  // A file-scope call does not have to name the target directly. `impact` returns
  // everything the reverse walk reached, and a top-level call landing on ANY of
  // those breaks when the target changes — `mid` calls the target, `late.js` calls
  // `mid` at file scope. So the file rows attach to the whole reached set, not
  // only to the target.
  it('lists a file-scope call that reaches the target through another symbol', async () => {
    write('app/mid.js', `import { Manager } from '../lib/manager.js';
export function mid() { const m = new Manager(); return m.eject(9); }
`);
    write('app/late.js', `import { mid } from './mid.js';
mid();
`);
    run(['index', '--full']);

    const text = run(['impact', 'Manager.eject']);
    expect(text).toContain('function mid');
    expect(text).toMatch(/file app\/late\.js\s+2/);
    // And the direct call is still there.
    expect(text).toMatch(/file app\/boot\.js\s+3, 4/);
  }, 30000);

  // `--json` and the text come from the same store call, so they cannot disagree
  // about whether a call site is in the answer or missing from it.
  it('agrees with --json for impact', async () => {
    const json = JSON.parse(run(['impact', 'Manager.eject', '--json']));
    expect(json.complete).toBe(true);
    expect(json.gaps).toEqual([]);
    expect(json.skipped_guesses).toBe(0);
    const fileRow = json.impact.find((r) => r.kind === 'file');
    expect(fileRow.qname).toBe('app/boot.js');
    expect(fileRow.start_line).toBe(null);
    expect(fileRow.call_sites.map((s) => s.line)).toEqual([3, 4]);
  }, 30000);

  // The text answer and `--json` must agree about the same question. A consumer
  // that reads `complete: true` while `gaps` still holds the two call sites has
  // no way to tell which half to believe.
  it('agrees with --json', async () => {
    const json = JSON.parse(run(['callers', 'Manager.eject', '--json']));
    expect(json.complete).toBe(true);
    expect(json.gaps).toEqual([]);
    const fileRow = json.callers.find((r) => r.kind === 'file');
    expect(fileRow.qname).toBe('app/boot.js');
    expect(fileRow.start_line).toBe(null);
    expect(fileRow.call_sites.map((s) => s.line)).toEqual([3, 4]);
  }, 30000);

  // One file, one certain call and one guessed call. A row's `guess` is
  // MIN(e.guess) over the calls it groups, so the row folds to CERTAIN and the
  // guessed line prints beside the certain one with nothing on the row to say so.
  // Node rows have always folded this way, and nothing here is invented — but the
  // rule tells the reader what a plain row is worth, so what a plain row really
  // promises has to be pinned: at least one of its lines is certain, not all of
  // them. `impact` is the way to split them, because it lists only the certain
  // ones.
  describe('a file that holds one certain call and one guess', () => {
    beforeEach(() => {
      // `const m = new Manager()` writes the receiver's type, so line 3 is
      // certain. `new Manager().eject(2)` on line 4 is matched by the method name
      // alone, so it is a guess.
      write('app/boot.js', `import { Manager } from '../lib/manager.js';
const m = new Manager();
m.eject(1);
new Manager().eject(2);
`);
      run(['index', '--full']);
    });

    it('prints one plain row for callers, holding both lines', async () => {
      const text = run(['callers', 'Manager.eject']);
      expect(text).toMatch(/file app\/boot\.js\s+3, 4/);
      // Nothing marks the guessed line, and the answer still says complete —
      // which is true, because no call site is missing.
      expect(text).not.toContain('UNVERIFIED');
      expect(text).toContain('✓ complete');

      const json = JSON.parse(run(['callers', 'Manager.eject', '--json']));
      const fileRow = json.callers.find((r) => r.kind === 'file');
      expect(fileRow.guess).toBe(0);
      expect(fileRow.call_sites.map((s) => s.line)).toEqual([3, 4]);
    }, 30000);

    it('shows only the certain line in impact, and says a guess was refused', async () => {
      const lines = run(['impact', 'Manager.eject']).split('\n').map((l) => l.trim());
      expect(lines).toContain('file app/boot.js  3');
      expect(lines).not.toContain('file app/boot.js  3, 4');

      const text = run(['impact', 'Manager.eject']);
      expect(text).toContain('1 guessed edge');
      // A refused edge disqualifies the completeness claim on its own.
      expect(text).not.toContain('✓ complete');
      expect(JSON.parse(run(['impact', 'Manager.eject', '--json'])).complete).toBe(false);
    }, 30000);
  });
});
