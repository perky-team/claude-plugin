import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEADS_RULE = join(HERE, '..', 'beads-arm-rule.md');

// Every plugin in this marketplace, not just the ones we remember using. A
// plugin left on joins all three arms, which does not bias the comparison but
// does stop `none` from being a floor — and the list of what the operator has
// switched on is not ours to predict.
export const OFF_SETTINGS = JSON.stringify({
  enabledPlugins: Object.fromEntries([
    ...['p-graph', 'p-tasks', 'p-wiki', 'p-statusline', 'p-flow', 'p-shed', 'p-observe', 'p-chat']
      .map((n) => [`${n}@perky.team`, false]),
    ['gopls-lsp@claude-plugins-official', false],
  ]),
  language: 'English',
});

// One list, two uses. A path that an arm owns has to be both removed when the
// arm changes and hidden from `git status`; keeping two hand-written lists in
// step is a drift waiting to happen.
const ARM_FILES = ['CLAUDE.md', '.claude', 'docs/tasks', '.beads'];

// A dirty `git status` is a hint one arm would have and another would not, so
// every arm's own files are excluded the same way, whichever arm is running.
// A bare name in an exclude file matches a file or a directory of that name,
// so the same list serves both without any decoration.
const EXCLUDE = `${ARM_FILES.join('\n')}\n`;

const clean = (dir) => {
  for (const p of ARM_FILES) rmSync(join(dir, p), { recursive: true, force: true });
};

/** Install one arm into a fresh clone. Returns the directory. */
export function prepArm({ arm, dir, pluginDir }) {
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'exclude'), EXCLUDE);
  clean(dir);

  if (arm === 'none') return dir;

  if (arm === 'ptasks') {
    execFileSync(process.execPath, [join(pluginDir, 'tools', 'ptasks.mjs'), 'init'],
      { cwd: dir, encoding: 'utf-8' });
    const rule = readFileSync(
      join(pluginDir, 'skills', '_shared', 'templates', 'p-tasks.rule.md.tpl'), 'utf-8');
    writeFileSync(join(dir, 'CLAUDE.md'), rule);
    return dir;
  }

  if (arm === 'beads') {
    execFileSync('bd', ['init'], { cwd: dir, encoding: 'utf-8' });
    writeFileSync(join(dir, 'CLAUDE.md'), readFileSync(BEADS_RULE, 'utf-8'));
    return dir;
  }

  throw new Error(`unknown arm: ${arm}`);
}

/**
 * Fail before the first dollar, not on the third arm two hours in. A rival that
 * is half-installed answers nothing, and the row would read "beads lost" when
 * what lost was the setup.
 */
export function preflight(arm) {
  if (arm !== 'beads') return;
  if (!existsSync(BEADS_RULE)) throw new Error(`missing rule file: ${BEADS_RULE}`);

  // Not "is it on PATH" but "does it work here". On Windows a `bd` that
  // resolves to a `.cmd` shim is found by `where` and then fails to spawn,
  // because Node cannot start a batch file without a shell. Running the real
  // command in a scratch directory catches that, and every other broken
  // install, before the study spends its first dollar.
  const scratch = mkdtempSync(join(tmpdir(), 'beads-preflight-'));
  try {
    const r = spawnSync('bd', ['init'], { cwd: scratch, encoding: 'utf-8' });
    if (r.error || r.status !== 0) {
      throw new Error('the beads arm is not ready: `bd init` did not work.\n'
        + `  ${(r.error?.message ?? (r.stderr || '').trim()) || `exit ${r.status}`}\n`
        + 'Install beads and check `bd init` runs in an empty directory, then re-run.\n'
        + 'Running the arm without it measures the setup, not the tool.');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
