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
});
