import { describe, expect, it } from 'vitest';
import { collectStatus, formatHuman } from '../lib/status.mjs';

const NOW = 1_753_000_000_000;

// collectStatus's injectable seam is `readPauseRecord` (see lib/status.mjs) — it was
// renamed from `readPause` when I2 introduced origin tracking. A stub keyed `readPause`
// here is silently ignored by the `{ ...defaults, ...deps }` spread (unknown extra key,
// real `readPauseRecord` still wins) and falls through to the real implementation against
// root '/nowhere', which happens to have no `.pshed` dir — so every test below passed
// without the injected pause stub ever being consulted at all.
const deps = (state: Record<string, unknown>) => ({
  readJobs: () => ({ defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go', guard: 'check' }] }),
  readJobState: () => state,
  readPauseRecord: () => null,
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
