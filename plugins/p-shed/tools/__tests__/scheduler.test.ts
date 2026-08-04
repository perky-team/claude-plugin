import { describe, expect, it } from 'vitest';
import { taskName, buildInstall, buildRemove, crontabLine, applyCrontab, removeFromCrontab, scanCrontabTaskIds, crontabHasTask, planRemoveCron, versionGlob } from '../lib/scheduler.mjs';

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

// install-cron used to write the versioned plugin-cache path straight into the crontab —
// a directory the plugin system considers disposable (measured on the live Pi: the
// 0.10.0 cache dir the crontab invoked every minute carried an .orphaned_at marker).
describe('version-independent tool resolution', () => {
  const cached = '/home/me/.claude/plugins/cache/perky-team/p-shed/0.10.0/tools/pshed.mjs';

  it('derives a glob from a versioned plugin-cache path', () => {
    expect(versionGlob(cached)).toBe('/home/me/.claude/plugins/cache/perky-team/p-shed/*/tools/pshed.mjs');
  });

  it('accepts a prerelease/build version segment', () => {
    expect(versionGlob('/c/p-shed/1.2.3-rc.1/tools/pshed.mjs')).toBe('/c/p-shed/*/tools/pshed.mjs');
  });

  it('returns null for a path with no version segment — a dev checkout stays literal', () => {
    expect(versionGlob('/projects/claude-plugin/plugins/p-shed/tools/pshed.mjs')).toBeNull();
    expect(versionGlob('/opt/p-shed/main/tools/pshed.mjs')).toBeNull();
  });

  it('only treats the segment directly above tools/ as the version', () => {
    expect(versionGlob('/c/1.0.0/p-shed/tools/pshed.mjs')).toBeNull();
  });

  it('crontabLine resolves the newest version at call time, with the literal path as fallback', () => {
    const line = crontabLine({ root, nodeBin, toolPath: cached });
    expect(line).toContain('sort -V');
    expect(line).toContain('/home/me/.claude/plugins/cache/perky-team/p-shed/*/tools/pshed.mjs');
    expect(line).toContain(cached); // the fallback keeps today's behaviour when the glob matches nothing
    expect(line).toContain(`# ${taskName(root)}`);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).not.toContain('%'); // crontab turns a bare % into a newline
  });

  it('crontabLine is byte-for-byte unchanged for a non-versioned path', () => {
    const dev = '/projects/claude-plugin/plugins/p-shed/tools/pshed.mjs';
    expect(crontabLine({ root, nodeBin, toolPath: dev }))
      .toBe(`* * * * * cd "${root}" && "${nodeBin}" "${dev}" tick > "${root}/.pshed/logs/cron.log" 2>&1 # ${taskName(root)}`);
  });

  // The marker contract: an upgrade that leaves an operator unable to remove their own
  // cron entry is worse than the problem being fixed.
  it('an old-style line written by an earlier p-shed is still found and removed', () => {
    const old = `* * * * * cd "${root}" && "${nodeBin}" "${cached}" tick > "${root}/.pshed/logs/cron.log" 2>&1 # ${taskName(root)}`;
    expect(crontabHasTask(old + '\n', root)).toBe(true);
    const plan = planRemoveCron(`0 5 * * * backup\n${old}\n`, root);
    expect(plan.removed).toBe(true);
    expect(plan.next).toBe('0 5 * * * backup');
  });

  it('remove-cron on a new-style line removes exactly one line and leaves the others', () => {
    const blob = [
      '0 5 * * * backup',
      crontabLine({ root, nodeBin, toolPath: cached }),
      `* * * * * cd /elsewhere && node x tick # ${taskName('/elsewhere')}`,
    ].join('\n') + '\n';
    const plan = planRemoveCron(blob, root);
    expect(plan.removed).toBe(true);
    expect(plan.next.split('\n')).toHaveLength(2);
    expect(plan.next).toContain('backup');
    expect(plan.next).toContain('/elsewhere');
  });

  it('scanCrontabTaskIds finds both an old-style and a new-style entry', () => {
    const blob = [
      `* * * * * cd "/a" && "${nodeBin}" "${cached}" tick # ${taskName('/a')}`,
      crontabLine({ root, nodeBin, toolPath: cached }),
    ].join('\n') + '\n';
    const ids = scanCrontabTaskIds(blob);
    expect(ids).toContain(taskName('/a'));
    expect(ids).toContain(taskName(root));
  });
});
