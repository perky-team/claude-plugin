import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(process.cwd(), 'plugins/p-shed/skills');
const read = (name: string) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf-8');

describe('p-shed skills', () => {
  it('ships init, start, stop, job, reset-breaker', () => {
    for (const s of ['init', 'start', 'stop', 'job', 'reset-breaker']) {
      expect(existsSync(join(skillsDir, s, 'SKILL.md'))).toBe(true);
    }
  });
  it('init scaffolds the required files and gitignores volatile ones, without writing a rule', () => {
    const init = read('init');
    for (const token of ['.pshed/jobs.yml', '.pshed/state/', '.pshed/logs/', '.pshed/run/', '.gitignore']) {
      expect(init).toContain(token);
    }
    expect(init.toLowerCase()).not.toContain('.claude/rules');
  });
  it('start refuses when not initialized (no auto-scaffold)', () => {
    expect(read('start')).toMatch(/p-shed:init/);
  });
  it('start/stop/job invoke the CLI, not a scaffold command', () => {
    expect(read('start')).toContain('install-cron');
    expect(read('stop')).toContain('remove-cron');
    expect(read('job')).toContain('set-job');
    expect(read('job')).toContain('rm-job');
  });
  it('reset-breaker skill invokes the reset-breaker command', () => {
    expect(read('reset-breaker')).toContain('reset-breaker');
  });
});
