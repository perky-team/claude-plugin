import { describe, expect, it } from 'vitest';
import { taskName, buildInstall, buildRemove, crontabLine, applyCrontab, removeFromCrontab, scanCrontabTaskIds, crontabHasTask, planRemoveCron } from '../lib/scheduler.mjs';

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
    expect(line).not.toContain('>>');
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

describe('crontab honesty helpers', () => {
  const line = crontabLine({ root, nodeBin, toolPath });
  const marker = `# ${taskName(root)}`;

  it('scanCrontabTaskIds lists every distinct pshed task id, once each', () => {
    const blob = applyCrontab('0 5 * * * backup\n', line, marker) +
      `* * * * * cd /elsewhere && node x tick # ${taskName('/elsewhere')}\n`;
    const ids = scanCrontabTaskIds(blob);
    expect(ids).toContain(taskName(root));
    expect(ids).toContain(taskName('/elsewhere'));
    expect(ids.filter((i) => i === taskName(root))).toHaveLength(1);
  });
  it('scanCrontabTaskIds returns [] for an empty or marker-less crontab', () => {
    expect(scanCrontabTaskIds('')).toEqual([]);
    expect(scanCrontabTaskIds('0 5 * * * backup\n')).toEqual([]);
  });
  it('crontabHasTask reports whether this folder\'s tick line is present', () => {
    const installed = applyCrontab('', line, marker);
    expect(crontabHasTask(installed, root)).toBe(true);
    expect(crontabHasTask('0 5 * * * backup\n', root)).toBe(false);
  });

  it('planRemoveCron reports removed:true and strips the line when the marker is present', () => {
    const installed = applyCrontab('0 5 * * * backup\n', line, marker);
    const plan = planRemoveCron(installed, root);
    expect(plan.removed).toBe(true);
    expect(plan.next).toBe('0 5 * * * backup');
    expect(plan.foundTaskIds).toContain(taskName(root));
  });
  it('planRemoveCron reports removed:false when this folder\'s marker is absent (wrong-dir incident)', () => {
    const other = `* * * * * cd /elsewhere && node x tick # ${taskName('/elsewhere')}\n`;
    const plan = planRemoveCron(other, root);
    expect(plan.removed).toBe(false);
    expect(plan.foundTaskIds).toEqual([taskName('/elsewhere')]);
  });
  it('planRemoveCron on an empty crontab removes nothing', () => {
    const plan = planRemoveCron('', root);
    expect(plan.removed).toBe(false);
    expect(plan.foundTaskIds).toEqual([]);
  });
});
