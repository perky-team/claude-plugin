import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
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
  it('leaves the none arm with no CLAUDE.md and no tracker', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'stale\n');
    prepArm({ arm: 'none', dir, pluginDir: PLUGIN });
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, 'docs', 'tasks'))).toBe(false);
  });

  it('gives the ptasks arm a rule and an initialised tracker', () => {
    prepArm({ arm: 'ptasks', dir, pluginDir: PLUGIN });
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toContain('/p-tasks:next');
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);
  }, 30_000);

  it('hides the arm files from git status, so the arms differ by one thing only', () => {
    prepArm({ arm: 'ptasks', dir, pluginDir: PLUGIN });
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('CLAUDE.md');
    expect(exclude).toContain('docs/tasks/');
    expect(exclude).toContain('.beads/');
  }, 30_000);
});
