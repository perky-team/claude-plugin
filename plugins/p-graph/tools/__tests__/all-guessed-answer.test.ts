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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-allguess-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// The two lines an answer can end with told the reader opposite things, and one
// answer printed both. `callers "AxiosHeaders.has"` on axios came back with
// **no certain row, 18 guesses, and `✓ complete`** — while the installed rule
// says `✓ complete` means "stop, do not grep" and says a guess means "open the
// file:line and read the call". The run obeyed both and cost 16.7 steps against
// grep's 9.7, and still dropped 10 real call sites.
//
// Twelve symbols in axios were in that state, three in got, seventeen in nest.
describe('an answer whose every row is a guess', () => {
  // One repo class owns `has`, and the receiver is an untyped parameter, so the
  // bare-name fallback answers it — a guess, and the only row.
  const ALL_GUESS = `export class AxiosHeaders {
  has(name) {
    return name in this;
  }
}

export function strip(set, header) {
  return set.has(header);
}
`;

  it('does not claim completeness', () => {
    write('lib/h.js', ALL_GUESS);
    run(['index', '--full']);

    const outText = run(['callers', 'AxiosHeaders.has', '--stale-ok']);
    expect(outText).toContain('UNVERIFIED');
    expect(outText).not.toContain('✓ complete');
    expect(outText).toContain('every row above is a guess');
  }, 30000);

  it('still says there are no gaps, because there are none', () => {
    write('lib/h.js', ALL_GUESS);
    run(['index', '--full']);

    const outText = run(['callers', 'AxiosHeaders.has', '--stale-ok']);
    expect(outText).not.toContain('missing from this answer');
    expect(outText).toContain('✓ no gaps');
  }, 30000);

  it('keeps complete true in --json and adds all_guessed', () => {
    // The JSON field is a claim about the GAP report, and that claim is still
    // true. The new fact goes in its own field rather than corrupting the old.
    write('lib/h.js', ALL_GUESS);
    run(['index', '--full']);

    const j = JSON.parse(run(['callers', 'AxiosHeaders.has', '--stale-ok', '--json']));
    expect(j.complete).toBe(true);
    expect(j.all_guessed).toBe(true);
  }, 30000);

  it('says ✓ complete as before when one row is certain', () => {
    write('lib/h.js', `${ALL_GUESS}
export function direct() {
  const h = new AxiosHeaders();
  return h.has('x');
}
`);
    run(['index', '--full']);

    const outText = run(['callers', 'AxiosHeaders.has', '--stale-ok']);
    expect(outText).toContain('UNVERIFIED');
    expect(outText).toContain('✓ complete');
    expect(JSON.parse(run(['callers', 'AxiosHeaders.has', '--stale-ok', '--json'])).all_guessed)
      .toBeUndefined();
  }, 30000);

  it('says ✓ complete as before when there is no row at all', () => {
    // Nothing calls it. An empty answer is not an answer full of guesses, and
    // the line that tells the reader to stop is exactly right here.
    write('lib/h.js', `export class AxiosHeaders {
  has(name) {
    return name in this;
  }
}
`);
    run(['index', '--full']);

    expect(run(['callers', 'AxiosHeaders.has', '--stale-ok'])).toContain('✓ complete');
  }, 30000);
});
