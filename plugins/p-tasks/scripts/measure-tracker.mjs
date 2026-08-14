#!/usr/bin/env node
// Does an agent finish a long job better WITH a task tracker than without, and
// does it matter which tracker?
//
//   node plugins/p-tasks/scripts/measure-tracker.mjs --smoke
//   node plugins/p-tasks/scripts/measure-tracker.mjs --pilot
//   node plugins/p-tasks/scripts/measure-tracker.mjs --arm ptasks
//   node plugins/p-tasks/scripts/measure-tracker.mjs --score
//
// Three arms over the same polygon: `none` has no tracker at all, `ptasks` and
// `beads` each have one. Ten fresh sessions a run, five runs an arm. Nothing is
// judged by a model: after every session the tree is copied and scored against
// a hidden node:test suite the agent never sees.
//
// Rows are appended to runs.jsonl and a finished run is never repeated, so this
// can be stopped and restarted.
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OFF_SETTINGS, prepArm, preflight } from './measure-tracker/arms.mjs';
import { runSession } from './measure-tracker/session.mjs';
import { snapshot, changedLines } from './measure-tracker/snapshot.mjs';
import { scoreSnapshot, expectedTests } from './measure-tracker/score.mjs';
import { report } from './measure-tracker/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const POLYGON = join(HERE, 'polygon');
const REFERENCE = join(HERE, 'polygon-reference');
const ACCEPTANCE = join(HERE, 'polygon-acceptance', 'acceptance.test.js');

const ARMS = ['none', 'ptasks', 'beads'];
const RUNS = 5;
const SESSIONS = 10;
const CAP_USD = 5;
const MODEL = 'sonnet';

const args = process.argv.slice(2);
const flag = (n, f = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return f;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

// Its own work directory and its own settings file. A p-graph measurement may
// be running at the same time and must not be disturbed. `--smoke` gets a
// directory of its own too: it is a one-session pilot-of-the-pilot, and if it
// wrote into the same runs.jsonl as everything else, `pendingWork` would read
// its rows as a finished run and the real `--pilot` right after it would
// silently do no work.
export function defaultWorkDir(args) {
  return join(tmpdir(), args.includes('--smoke') ? 'ptasks-measure-smoke' : 'ptasks-measure');
}
const work = String(flag('work', defaultWorkDir(args)));
const runsFile = join(work, 'runs.jsonl');
const settingsFile = join(work, 'ptasks-arm-settings.json');
const maxTotalUsd = Number(flag('max-total-usd', 150));

/** Which (arm, run) pairs still need doing. A run with any row is finished. */
export function pendingWork(rows, { arms, runs }) {
  const seen = new Set(rows.map((r) => `${r.arm} ${r.run}`));
  const out = [];
  for (const arm of arms) {
    for (let run = 1; run <= runs; run++) {
      if (!seen.has(`${arm} ${run}`)) out.push({ arm, run });
    }
  }
  return out;
}

/**
 * The snapshot root for one (arm, run) pair, cleared before its first
 * snapshot. `cpSync` merges into an existing destination rather than pruning
 * it, so a re-run of the same pair would otherwise inherit every file an
 * earlier, possibly bad, attempt wrote and this attempt has not touched yet —
 * exactly the run someone is redoing because they don't trust it.
 */
export function clearSnapshotRoot(work, arm, run) {
  const snapRoot = join(work, 'snapshots', `${arm}-${run}`);
  rmSync(snapRoot, { recursive: true, force: true });
  return snapRoot;
}

const readRows = () => (existsSync(runsFile)
  ? readFileSync(runsFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

// Looked up when a session is about to run, never at import time: this module
// is imported by a unit test, and a machine without the CLI installed must not
// fail to import it.
function findClaude() {
  if (process.platform !== 'win32') return 'claude';
  const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai',
    'claude-code', 'bin', 'claude.exe');
  if (existsSync(exe)) return exe;
  throw new Error(`claude.exe not found at ${exe}`);
}

// The polygon is a directory inside this repository, not a repository of its
// own, so there is nothing to clone: copy it and give the copy one seed commit.
// The commit happens before the arm is installed, so no arm's own files are in
// the history that every arm starts from.
function freshCopy(arm, run) {
  const dir = join(work, `${arm}-${run}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(POLYGON, dir, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=harness@local', '-c', 'user.name=harness',
    'commit', '--quiet', '-m', 'seed'], { cwd: dir });
  return prepArm({ arm, dir, pluginDir: PLUGIN });
}

async function runOne(arm, run, sessions, expected) {
  const claudeBin = findClaude();
  const dir = freshCopy(arm, run);
  const snapRoot = clearSnapshotRoot(work, arm, run);
  const seedSnap = snapshot(dir, join(snapRoot, 's00'));
  let prev = seedSnap;
  let consecutiveErrors = 0;

  for (let session = 1; session <= sessions; session++) {
    process.stderr.write(`  ${arm} #${run} session ${session} … `);
    const res = runSession({
      dir, arm, pluginDir: PLUGIN, settingsFile, capUsd: CAP_USD, model: MODEL, claudeBin,
    });
    const snap = snapshot(dir, join(snapRoot, `s${String(session).padStart(2, '0')}`));
    const row = {
      arm, run, session,
      ...res,
      tests: scoreSnapshot({ snapshotDir: snap, acceptanceFile: ACCEPTANCE, expected }),
      changed_lines_from_prev: changedLines(prev, snap),
      changed_lines_from_seed: changedLines(seedSnap, snap),
    };
    appendFileSync(runsFile, `${JSON.stringify(row)}\n`);
    prev = snap;

    // The brake goes here, before any early return below. A session that ends
    // its run — because everything went green, or because it just took the
    // third strike — would otherwise skip the check entirely, and the next run
    // would start on money we already said we would not spend.
    const spent = readRows().reduce((n, r) => n + (r.cost_usd ?? 0), 0);
    if (spent > maxTotalUsd) {
      throw new Error(`stopping: spent $${spent.toFixed(2)}, over --max-total-usd ${maxTotalUsd}`);
    }

    const green = row.tests ? Object.values(row.tests) : [];
    const doneNow = green.length > 0 && green.every(Boolean);
    process.stderr.write(res.error
      ? `ERROR ${res.error}\n`
      : `$${(res.cost_usd ?? 0).toFixed(3)} ${green.filter(Boolean).length}/${green.length}\n`);

    consecutiveErrors = res.error ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) {
      process.stderr.write(`  ${arm} #${run} aborted after three failed sessions\n`);
      return;
    }
    if (doneNow) {
      process.stderr.write(`  ${arm} #${run} finished at session ${session}\n`);
      return;
    }
  }
}

async function main() {
  // A typo turns the brake off without saying so: `Number('15O')` is NaN, and
  // `spent > NaN` is false for every amount of money there is. Checked here
  // rather than at module load, because the queue test imports this file.
  if (!Number.isFinite(maxTotalUsd) || maxTotalUsd <= 0) {
    throw new Error(`--max-total-usd must be a positive number, got: ${flag('max-total-usd')}`);
  }

  mkdirSync(work, { recursive: true });
  writeFileSync(settingsFile, OFF_SETTINGS);

  if (flag('score')) { process.stdout.write(report(readRows())); return; }

  const smoke = Boolean(flag('smoke'));
  const pilot = Boolean(flag('pilot'));
  const arms = flag('arm') ? [String(flag('arm'))] : (pilot ? ['none', 'ptasks'] : ARMS);
  const runs = smoke || pilot ? 1 : RUNS;
  const sessions = smoke ? 1 : SESSIONS;

  for (const arm of arms) preflight(arm);

  // Read the suite's test list once, from the reference, before any session
  // runs. If this comes back short, the hidden suite is broken and every
  // score afterwards would be wrong in the same direction.
  const expected = expectedTests({ referenceDir: REFERENCE, acceptanceFile: ACCEPTANCE });
  if (expected.length < 30) throw new Error(`the hidden suite reported only ${expected.length} tests against the reference`);

  for (const { arm, run } of pendingWork(readRows(), { arms, runs })) {
    await runOne(arm, run, sessions, expected);
  }
  process.stdout.write(report(readRows()));
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
