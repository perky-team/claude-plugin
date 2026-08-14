import { spawnSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// One unindented TAP line per top-level test. Node indents subtests, which is
// why the hidden suite is required to be flat.
const LINE = /^(not )?ok \d+ - (.+?)\s*$/gm;

/** TAP text to { '<test name>': true|false }, one entry per top-level test. */
export function parseTap(text) {
  const out = {};
  for (const [, notOk, name] of text.matchAll(LINE)) out[name] = !notOk;
  return out;
}

function runSuite(dir, acceptanceFile, timeoutMs) {
  const target = join(dir, 'acceptance.test.js');
  try {
    copyFileSync(acceptanceFile, target);
    const r = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', 'acceptance.test.js'],
      { cwd: dir, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1 << 26 });
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  } finally {
    rmSync(target, { force: true });
  }
}

/**
 * The test names the suite has, read from a run against the reference. The
 * reference is what "all green" means, so this list cannot drift from the
 * suite the way a hand-written manifest would.
 */
export function expectedTests({ referenceDir, acceptanceFile, timeoutMs = 120_000 }) {
  return Object.keys(parseTap(runSuite(referenceDir, acceptanceFile, timeoutMs)));
}

/**
 * Copy the hidden suite into a snapshot, run it, read the result, remove it.
 * The agent's own directory is never given this file — only a snapshot copy is.
 *
 * Every expected test gets an entry. A test the run never reached is `false`:
 * a crash after four passes has not shown that the fifth behaviour works, and
 * dropping it would score that snapshot four out of four.
 */
export function scoreSnapshot({ snapshotDir, acceptanceFile, expected, timeoutMs = 120_000 }) {
  const out = runSuite(snapshotDir, acceptanceFile, timeoutMs);
  // No TAP at all means the runner never started — a fault in the harness, not
  // a result about the code. Say "did not score" instead of "all red".
  if (!out.includes('TAP version') && !/^(not )?ok \d+ - /m.test(out)) return null;
  const said = parseTap(out);
  return Object.fromEntries(expected.map((name) => [name, said[name] === true]));
}
