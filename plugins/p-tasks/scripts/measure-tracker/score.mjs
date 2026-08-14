import { spawnSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// One unindented TAP line per top-level test. Node indents subtests, which is
// why the hidden suite is required to be flat.
const LINE = /^(not )?ok \d+ - (.+?)\s*$/gm;

// Per test, not per run. Without it, one hanging test hangs the whole runner
// until the spawn timeout kills it — and a killed runner makes Node collapse
// the entire file into one `not ok 1 - acceptance.test.js` line, throwing away
// the `ok` lines of every test that had already passed. That would score a
// snapshot 0 of 37 for a single infinite loop. Measured: with this flag a hang
// becomes one failed test and its neighbours still report `ok`.
//
// 3s is about a thousand times what these tests need, and 37 of them can all
// time out inside the spawn timeout below.
const TEST_TIMEOUT_MS = 3_000;
const RUN_TIMEOUT_MS = 180_000;

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
      ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`, '--test-reporter=tap', 'acceptance.test.js'],
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
export function expectedTests({ referenceDir, acceptanceFile, timeoutMs = RUN_TIMEOUT_MS }) {
  return Object.keys(parseTap(runSuite(referenceDir, acceptanceFile, timeoutMs)));
}

/**
 * Turn a run's output into one entry per expected test. Pure, so the rule that
 * decides "did not score" against "scored all red" can be tested directly —
 * the real thing needs a runner that fails to start, which no test can stage.
 */
export function resultFrom(output, expected) {
  // No TAP at all means the runner never started: a fault in the harness, not
  // a result about the code. Say "did not score" instead of "all red".
  if (!output.includes('TAP version') && !/^(not )?ok \d+ - /m.test(output)) return null;
  const said = parseTap(output);
  return Object.fromEntries(expected.map((name) => [name, said[name] === true]));
}

/**
 * Copy the hidden suite into a snapshot, run it, read the result, remove it.
 * The agent's own directory is never given this file — only a snapshot copy is.
 *
 * Every expected test gets an entry. A test the run never reached is `false`:
 * a crash after four passes has not shown that the fifth behaviour works, and
 * dropping it would score that snapshot four out of four.
 */
export function scoreSnapshot({ snapshotDir, acceptanceFile, expected, timeoutMs = RUN_TIMEOUT_MS }) {
  return resultFrom(runSuite(snapshotDir, acceptanceFile, timeoutMs), expected);
}
