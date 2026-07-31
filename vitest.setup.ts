import { afterEach } from 'vitest';

// Yield one macrotask after every test.
//
// Most e2e suites here drive a CLI through execFileSync/spawnSync, which blocks the
// worker's event loop outright, and `await` between tests only queues MICROtasks — so
// an entire file can run without the loop ever reaching the timers/poll phase. Two
// things live in that stalled loop: the reply to the worker's `onTaskUpdate` RPC, and
// birpc's 60 s timeout timer for that same call. Once the accumulated block passes
// 60 s the timer fires the moment the loop finally spins, and the run ends with
// `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` — every assertion passing,
// exit code 1. Measured: plugins/p-graph/.../cli-autorefresh.test.ts blocked 61 s
// straight across 7 synchronous tests (longest single test: 13.7 s).
//
// One macrotask per test lets the worker drain those replies, so the timer is cleared
// long before it can expire. The headroom is per-test rather than per-file: a SINGLE
// test blocking for over 60 s would still trip it — keep individual e2e tests well
// under that, or make their child-process calls async.
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
