import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildArgs, runJob } from '../lib/launch.mjs';

const defaults = { cwd: '.', timeoutSec: 900, permissionMode: 'acceptEdits', allowedTools: 'Read,Write' };

describe('buildArgs', () => {
  it('assembles the claude -p command', () => {
    expect(buildArgs({ prompt: 'go' }, defaults)).toEqual([
      '-p', 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write',
    ]);
  });
  it('per-job overrides win and allowedTools is optional', () => {
    expect(buildArgs({ prompt: 'go', permissionMode: 'plan', allowedTools: '' }, defaults)).toEqual([
      '-p', 'go', '--output-format', 'json', '--permission-mode', 'plan',
    ]);
  });
  it('appends --model when the job sets it', () => {
    expect(buildArgs({ prompt: 'go', model: 'sonnet' }, defaults)).toEqual([
      '-p', 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write', '--model', 'sonnet',
    ]);
  });
  it('falls back to defaults.model, and job.model overrides it', () => {
    expect(buildArgs({ prompt: 'go' }, { ...defaults, model: 'haiku' })).toContain('haiku');
    expect(buildArgs({ prompt: 'go', model: 'opus' }, { ...defaults, model: 'haiku' })).toContain('opus');
    expect(buildArgs({ prompt: 'go', model: 'opus' }, { ...defaults, model: 'haiku' })).not.toContain('haiku');
  });
  it('omits --model when neither job nor defaults set it', () => {
    expect(buildArgs({ prompt: 'go' }, defaults)).not.toContain('--model');
  });
  it('appends --effort when the job sets it', () => {
    const args = buildArgs({ prompt: 'go', effort: 'high' }, defaults);
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });
  it('falls back to defaults.effort, and job.effort overrides it', () => {
    expect(buildArgs({ prompt: 'go' }, { ...defaults, effort: 'low' })).toContain('low');
    const both = buildArgs({ prompt: 'go', effort: 'xhigh' }, { ...defaults, effort: 'low' });
    expect(both).toContain('xhigh');
    expect(both).not.toContain('low');
  });
  it('omits --effort when neither job nor defaults set it', () => {
    expect(buildArgs({ prompt: 'go' }, defaults)).not.toContain('--effort');
  });
  it('omits --effort for a Haiku model even when effort is set', () => {
    expect(buildArgs({ prompt: 'go', model: 'haiku', effort: 'high' }, defaults)).not.toContain('--effort');
    expect(buildArgs({ prompt: 'go', effort: 'high' }, { ...defaults, model: 'claude-haiku-4-5-20251001' })).not.toContain('--effort');
  });
});

describe('runJob', () => {
  it('resolves with the exit code on normal exit', async () => {
    const child: any = new EventEmitter();
    child.pid = 4242;
    const spawnFn = vi.fn(() => child);
    const p = runJob({ job: { prompt: 'go' }, defaults, claudeBin: 'claude', spawnFn, now: () => 1000 });
    child.emit('exit', 0);
    await expect(p).resolves.toMatchObject({ pid: 4242, exit: 0, timedOut: false });
  });

  it('kills the process tree on timeout', async () => {
    vi.useFakeTimers();
    const child: any = new EventEmitter();
    child.pid = 99;
    const spawnFn = vi.fn(() => child);
    const killFn = vi.fn();
    const p = runJob({ job: { prompt: 'go', timeoutSec: 1 }, defaults, claudeBin: 'claude', spawnFn, killFn, now: () => 0 });
    vi.advanceTimersByTime(1000);
    expect(killFn).toHaveBeenCalledWith(99);
    child.emit('exit', null);           // process dies after the kill
    await expect(p).resolves.toMatchObject({ timedOut: true, exit: null });
    vi.useRealTimers();
  });

  it('calls onSpawn with the child pid right after spawn, before exit', async () => {
    const child: any = new EventEmitter();
    child.pid = 55;
    const spawnFn = vi.fn(() => child);
    const onSpawn = vi.fn();
    const p = runJob({ job: { prompt: 'go' }, defaults, claudeBin: 'claude', spawnFn, onSpawn, now: () => 0 });
    expect(onSpawn).toHaveBeenCalledWith(55);   // fired synchronously, before we emit exit
    child.emit('exit', 0);
    await p;
  });

  it('resolves (does not hang or throw) when the child emits error', async () => {
    const child: any = new EventEmitter();
    child.pid = undefined;
    const spawnFn = vi.fn(() => child);
    const p = runJob({ job: { prompt: 'go' }, defaults, claudeBin: 'bad', spawnFn, now: () => 0 });
    child.emit('error', new Error('spawn ENOENT'));
    await expect(p).resolves.toMatchObject({ exit: null, timedOut: false });
  });

  it('captures stdout/stderr into the result so the run can be classified', async () => {
    const child: any = new EventEmitter();
    child.pid = 7;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnFn = vi.fn(() => child);
    const p = runJob({ job: { prompt: 'go' }, defaults, claudeBin: 'claude', spawnFn, now: () => 0 });
    child.stdout.emit('data', Buffer.from('hello '));
    child.stdout.emit('data', Buffer.from('world'));
    child.stderr.emit('data', Buffer.from('a warning'));
    child.emit('exit', 0);
    await expect(p).resolves.toMatchObject({ exit: 0, out: 'hello world', err: 'a warning' });
  });
});
