import { describe, expect, it } from 'vitest';

// Guards the fix for: `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`.
//
// Most e2e tests in this repo drive a CLI through execFileSync/spawnSync, which blocks
// the worker's event loop outright. `await` between tests only queues MICROtasks, so a
// whole file can run without the loop ever reaching the timers/poll phase. The worker
// then never reads the main process's reply to its onTaskUpdate RPC, and birpc's 60 s
// timer — which lives in that same worker — fires the moment the loop finally spins.
// Measured before the fix: plugins/p-graph/.../cli-autorefresh.test.ts blocked for
// 61 s straight across 7 synchronous tests (longest single test: 13.7 s).
//
// The fix is a global afterEach in vitest.config.ts's setupFiles that yields one
// macrotask per test. This test asserts that yield actually happens: a timer armed
// during a blocking test must have fired by the time the next test starts.
let ticks = 0;
let timer: NodeJS.Timeout | undefined;

describe('vitest runner yields to the event loop between tests', () => {
  it('a synchronous test blocks the loop completely (nothing runs during it)', () => {
    ticks = 0;
    timer = setInterval(() => { ticks++; }, 25);
    const until = Date.now() + 400;
    while (Date.now() < until) { /* busy-wait, exactly like a spawnSync-driven e2e */ }
    expect(ticks).toBe(0); // proves the block is real: no timer ran inside the test
  });

  it('timers armed in the previous test have run before this one starts', () => {
    clearInterval(timer);
    // Without a macrotask between tests this is still 0, and 60 s worth of such tests
    // in one file kills the worker's RPC.
    expect(ticks).toBeGreaterThan(0);
  });
});
