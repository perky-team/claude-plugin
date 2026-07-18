import { describe, expect, it } from 'vitest';
import { makeEvent, severityFor } from '../lib/event.mjs';

describe('severityFor', () => {
  it('errors on non-zero exit or timeout', () => {
    expect(severityFor('job.finished', { exit: 1 })).toBe('error');
    expect(severityFor('job.finished', { exit: 0, timedOut: true })).toBe('error');
  });
  it('ok on clean job completion', () => {
    expect(severityFor('job.finished', { exit: 0 })).toBe('ok');
  });
  it('warns on drift and conflict', () => {
    expect(severityFor('drift.warn', {})).toBe('warn');
    expect(severityFor('wiki.conflict', {})).toBe('warn');
  });
  it('errors on a failed pgraph refresh', () => {
    expect(severityFor('index.refresh', { error: true })).toBe('error');
  });
  it('info for everything else', () => {
    expect(severityFor('task.status', {})).toBe('info');
    expect(severityFor('job.launched', {})).toBe('info');
  });
});

describe('makeEvent', () => {
  it('builds the canonical shape with derived severity', () => {
    const e = makeEvent('p-shed', 'job.finished', 'daily-index', 'exit 0 (42s)', { exit: 0, durationMs: 42000 }, 1000);
    expect(e).toEqual({
      ts: 1000, plugin: 'p-shed', kind: 'job.finished', entity: 'daily-index',
      severity: 'ok', summary: 'exit 0 (42s)', data: { exit: 0, durationMs: 42000 },
    });
  });
  it('defaults data to {} and severity accordingly', () => {
    const e = makeEvent('p-tasks', 'task.added', 'TASK-9', 'added', undefined, 5);
    expect(e.data).toEqual({});
    expect(e.severity).toBe('info');
  });
});
