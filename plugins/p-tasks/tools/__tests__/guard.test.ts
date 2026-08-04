import { describe, expect, it } from 'vitest';
import { GUARD_QUIET, evaluateGuard } from '../lib/guard.mjs';

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: 'task', title: id, description: '', status: 'todo', blockedBy: [], ...over,
});

describe('evaluateGuard', () => {
  it('quiet on an empty backlog', () => {
    const g = evaluateGuard([]);
    expect(g.exit).toBe(GUARD_QUIET);
    expect(g.result).toBe('quiet');
    expect(g.next).toBeNull();
  });

  it('quiet when every item is done', () => {
    const g = evaluateGuard([task('t-1', { status: 'done' }), task('t-2', { status: 'done' })]);
    expect(g.exit).toBe(GUARD_QUIET);
  });

  it('ready with one actionable item, and names it', () => {
    const g = evaluateGuard([task('t-1')]);
    expect(g.exit).toBe(0);
    expect(g.result).toBe('ready');
    expect(g.next.id).toBe('t-1');
    expect(g.reason).toContain('t-1');
  });

  it('quiet when every open item sits behind a non-done blocker', () => {
    const g = evaluateGuard([
      task('t-1', { status: 'done' }),
      task('t-2', { blockedBy: ['t-3'] }),
      task('t-3', { blockedBy: ['t-2'] }),
    ]);
    expect(g.exit).toBe(GUARD_QUIET);
    expect(g.open).toBe(2);
    expect(g.blocked).toBe(2);
  });

  it('quiet when the only candidates are excluded by origin', () => {
    const g = evaluateGuard(
      [task('t-1', { origin: 'human:question' }), task('t-2', { origin: 'human:review' })],
      { excludeOrigin: ['human:'] },
    );
    expect(g.exit).toBe(GUARD_QUIET);
    expect(g.excluded).toBe(2);
    expect(g.open).toBe(2);
  });

  it('ready when one item is excluded and another is actionable', () => {
    const g = evaluateGuard(
      [task('t-1', { origin: 'human:question' }), task('t-2', { origin: 'plan' })],
      { excludeOrigin: ['human:'] },
    );
    expect(g.exit).toBe(0);
    expect(g.next.id).toBe('t-2');
  });

  it('honours a repeated --exclude-origin', () => {
    const g = evaluateGuard(
      [task('t-1', { origin: 'human:q' }), task('t-2', { origin: 'code-review:low' })],
      { excludeOrigin: ['human:', 'code-review:'] },
    );
    expect(g.exit).toBe(GUARD_QUIET);
    expect(g.excluded).toBe(2);
  });

  it('leaves items without an origin alone', () => {
    const g = evaluateGuard([task('t-1')], { excludeOrigin: ['human:'] });
    expect(g.exit).toBe(0);
  });

  it('quiet on a blocker id that does not exist, and warns like pickNext', () => {
    const warns: string[] = [];
    const g = evaluateGuard([task('t-1', { blockedBy: ['nope'] })], { onWarn: (m: string) => warns.push(m) });
    expect(g.exit).toBe(GUARD_QUIET);
    expect(warns[0]).toMatch(/nope/);
  });

  it('does not let an excluded item hide its dependents', () => {
    // An excluded blocker must still resolve as a blocker: filtering it out of the
    // input before pickNext would make t-2 look like it depends on a missing id.
    const g = evaluateGuard(
      [task('t-1', { origin: 'human:q', status: 'done' }), task('t-2', { blockedBy: ['t-1'] })],
      { excludeOrigin: ['human:'] },
    );
    expect(g.exit).toBe(0);
    expect(g.next.id).toBe('t-2');
  });

  it('reports the same selection as pickNext when nothing is excluded', () => {
    const items = [task('t-1'), task('t-2', { status: 'in_progress' })];
    expect(evaluateGuard(items).next.id).toBe('t-2');
  });

  it('keeps the reason on one short line', () => {
    const many = Array.from({ length: 40 }, (_, i) => task(`t-${i + 1}`, { origin: 'human:q' }));
    const g = evaluateGuard(many, { excludeOrigin: ['human:'] });
    expect(g.reason).not.toContain('\n');
    expect(g.reason.length).toBeLessThanOrEqual(100);
    expect(g.reason).toMatch(/40 open/);
  });

  it('counts blocked and excluded separately in the reason', () => {
    const g = evaluateGuard(
      [
        task('t-1', { origin: 'human:q' }),
        task('t-2', { blockedBy: ['t-3'] }),
        task('t-3', { blockedBy: ['t-2'] }),
      ],
      { excludeOrigin: ['human:'] },
    );
    expect(g.exit).toBe(GUARD_QUIET);
    expect(g.open).toBe(3);
    expect(g.excluded).toBe(1);
    expect(g.blocked).toBe(2);
    expect(g.reason).toMatch(/1 excluded/);
    expect(g.reason).toMatch(/2 blocked/);
  });

  it('uses the p-shed quiet code, not a generic failure code', () => {
    expect(GUARD_QUIET).toBe(75);
  });
});
