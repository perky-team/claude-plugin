import { describe, expect, it } from 'vitest';
import { collectStatus, formatHuman } from '../lib/status.mjs';

const NOW = 1_753_000_000_000;

const deps = (state: Record<string, unknown>) => ({
  readJobs: () => ({ defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go', guard: 'check' }] }),
  readJobState: () => state,
  readPause: () => null,
  readGlobalPause: () => null,
  readPid: () => null,
  isPidAlive: () => false,
});

describe('status + guard', () => {
  it('surfaces lastGuard and consecutiveGuardFailures per job', () => {
    const s = collectStatus('/nowhere', {
      installed: false,
      deps: deps({ lastRun: NOW - 40_000, lastGuard: { at: NOW - 40_000, outcome: 'quiet', exit: 75 }, consecutiveGuardFailures: 1 }),
    });
    expect(s.jobs[0].lastGuard).toMatchObject({ outcome: 'quiet', exit: 75 });
    expect(s.jobs[0].consecutiveGuardFailures).toBe(1);
  });

  it('formatHuman shows guard outcome + freshness ("checked 40 s ago" stays visible)', () => {
    const s = collectStatus('/nowhere', {
      installed: false,
      deps: deps({ lastRun: NOW - 40_000, lastGuard: { at: NOW - 40_000, outcome: 'quiet', exit: 75 } }),
    });
    const text = formatHuman(s, NOW);
    expect(text).toContain('guard');
    expect(text).toContain('quiet 40s ago');
  });

  it('a guardless job shows "-" and zero guard failures', () => {
    const s = collectStatus('/nowhere', { installed: false, deps: deps({ lastRun: 1 }) });
    expect(s.jobs[0].consecutiveGuardFailures).toBe(0);
    expect(s.jobs[0].lastGuard).toBeUndefined();
    const line = formatHuman(s, NOW).split('\n').at(-1)!;
    expect(line.endsWith('-')).toBe(true);
  });
});
