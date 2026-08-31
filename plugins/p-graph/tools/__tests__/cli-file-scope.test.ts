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

  // `impact` is the one command that still needs the ⚠ line for these calls, and
  // that is why the gap rows were not deleted outright. It walks resolved edges
  // that HAVE a caller, so it lists no file row and cannot name these two sites
  // any other way. Dropping the report here would hide them completely and let
  // `impact` claim `✓ complete` — the exact failure this branch exists to fix.
  it('keeps naming the call sites in impact, which lists no file row', async () => {
    const text = run(['impact', 'Manager.eject']);
    expect(text).not.toContain('file app/boot.js');
    expect(text).toContain('2 call sites missing from this answer');
    expect(text).toContain('app/boot.js:3  outside any indexed symbol');
    expect(text).toContain('app/boot.js:4  outside any indexed symbol');
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
});
