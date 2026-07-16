import { describe, expect, it } from 'vitest';
import { taskName, buildInstall, buildRemove, crontabLine, applyCrontab, removeFromCrontab } from '../lib/scheduler.mjs';

const root = '/home/me/work';
const nodeBin = '/usr/bin/node';
const toolPath = '/plugins/p-shed/tools/pshed.mjs';

describe('taskName', () => {
  it('is stable and folder-scoped', () => {
    expect(taskName(root)).toBe(taskName(root));
    expect(taskName(root)).toMatch(/^pshed-[0-9a-f]{8}$/);
    expect(taskName('/other')).not.toBe(taskName(root));
  });
});

describe('windows schtasks', () => {
  it('install creates a per-minute task that cds into root', () => {
    const { file, args } = buildInstall({ platform: 'win32', root, nodeBin, toolPath });
    expect(file).toBe('schtasks');
    expect(args).toContain('/Create');
    expect(args).toContain('/SC'); expect(args).toContain('MINUTE');
    expect(args).toContain('/F');
    expect(args.join(' ')).toContain(taskName(root));
    expect(args.join(' ')).toContain('tick');
  });
  it('remove deletes the task by name', () => {
    const { file, args } = buildRemove({ platform: 'win32', root });
    expect(file).toBe('schtasks');
    expect(args).toContain('/Delete');
    expect(args.join(' ')).toContain(taskName(root));
  });
});

describe('posix crontab transforms', () => {
  const marker = `# ${taskName(root)}`;
  it('crontabLine runs tick every minute in root, tagged with the marker', () => {
    const line = crontabLine({ root, nodeBin, toolPath });
    expect(line).toContain('* * * * *');
    expect(line).toContain(root);
    expect(line).toContain('tick');
    expect(line).toContain(marker);
  });
  it('applyCrontab is idempotent', () => {
    const line = crontabLine({ root, nodeBin, toolPath });
    const once = applyCrontab('', line, marker);
    const twice = applyCrontab(once, line, marker);
    expect(twice).toBe(once);
    expect(once.split('\n').filter((l) => l.includes(marker))).toHaveLength(1);
  });
  it('removeFromCrontab strips only the tagged line', () => {
    const line = crontabLine({ root, nodeBin, toolPath });
    const withUser = applyCrontab('0 5 * * * backup\n', line, marker);
    const removed = removeFromCrontab(withUser, marker);
    expect(removed).toBe('0 5 * * * backup');
  });
});
