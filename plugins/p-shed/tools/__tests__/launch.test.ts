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
});
