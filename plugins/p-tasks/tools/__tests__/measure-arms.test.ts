import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFF_SETTINGS, prepArm } from '../../scripts/measure-tracker/arms.mjs';
import { repoRoot } from '../../../../tests/helpers';

const PLUGIN = join(repoRoot(), 'plugins', 'p-tasks');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arm-'));
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('OFF_SETTINGS', () => {
  it('switches off every plugin that would otherwise join the none arm', () => {
    const parsed = JSON.parse(OFF_SETTINGS);
    expect(parsed.enabledPlugins['p-graph@perky.team']).toBe(false);
    expect(parsed.enabledPlugins['p-tasks@perky.team']).toBe(false);
    expect(parsed.enabledPlugins['p-wiki@perky.team']).toBe(false);
  });
});

describe('prepArm', () => {
  it('leaves the none arm with nothing any arm left behind', () => {
    // Seed all of it, not only CLAUDE.md: a run directory is reused between
    // arms, so `none` has to undo whatever the arm before it installed.
    writeFileSync(join(dir, 'CLAUDE.md'), 'stale\n');
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    mkdirSync(join(dir, '.beads'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    prepArm({ arm: 'none', dir, pluginDir: PLUGIN });
    for (const p of ['CLAUDE.md', 'docs/tasks', '.beads', '.claude']) {
      expect(existsSync(join(dir, p)), p).toBe(false);
    }
  });

  it('gives the ptasks arm a rule and an initialised tracker', () => {
    prepArm({ arm: 'ptasks', dir, pluginDir: PLUGIN });
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toContain('/p-tasks:next');
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);
  }, 30_000);

  // Ask git, do not re-read our own constant. The failure this guards against
  // is a file the tracker's installer writes that the exclude list does not
  // name — and a test that only greps the list it is validating can never see
  // that. This is the property the whole study rests on: the arms must differ
  // by the tracker and by nothing else.
  it('leaves git status clean after installing an arm', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '--quiet', '-m', 'seed'], { cwd: dir });

    prepArm({ arm: 'ptasks', dir, pluginDir: PLUGIN });

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  }, 30_000);
});
