import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEADS_RULE = join(HERE, '..', 'beads-arm-rule.md');

// The operator's own machine has plugins switched on for every session. Left
// alone they would quietly join the `none` arm and void the comparison. Each
// arm gets back exactly one thing, through --plugin-dir or the bd binary.
export const OFF_SETTINGS = JSON.stringify({
  enabledPlugins: {
    'p-graph@perky.team': false,
    'p-tasks@perky.team': false,
    'p-wiki@perky.team': false,
    'p-statusline@perky.team': false,
    'gopls-lsp@claude-plugins-official': false,
  },
  language: 'English',
});

// A dirty `git status` is a hint one arm would have and another would not, so
// every arm's own files are excluded the same way, whichever arm is running.
const EXCLUDE = 'CLAUDE.md\n.claude/\ndocs/tasks/\n.beads/\n';

const clean = (dir) => {
  for (const p of ['CLAUDE.md', '.claude', 'docs/tasks', '.beads']) {
    rmSync(join(dir, p), { recursive: true, force: true });
  }
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
  const where = process.platform === 'win32' ? 'where' : 'which';
  if (spawnSync(where, ['bd'], { encoding: 'utf-8' }).status !== 0) {
    throw new Error('the beads arm is not ready: `bd` is not on PATH.\n'
      + 'Install it and re-run. Running the arm without it measures the setup, not the tool.');
  }
  if (!existsSync(BEADS_RULE)) throw new Error(`missing rule file: ${BEADS_RULE}`);
}
