// tui-driver.test.ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { runTui } from '../lib/tui/driver.mjs';
import { createBus } from '../lib/bus.mjs';

function fakeIO() {
  const stdin = new EventEmitter();
  stdin.setRawMode = () => {}; // guarded feature present
  stdin.resume = () => {};
  stdin.pause = () => {};
  const writes = [];
  const stdout = new EventEmitter();
  stdout.write = (s) => { writes.push(s); return true; };
  stdout.columns = 60; stdout.rows = 12;
  return { stdin, stdout, writes };
}

describe('runTui', () => {
  it('paints on start and resolves when q is pressed', async () => {
    const { stdin, stdout, writes } = fakeIO();
    const bus = createBus({ size: 100 });
    const adapters = { pshed: { status: () => ({ running: [], jobs: {} }) } };
    const done = runTui({ bus, adapters, stdin, stdout, size: { width: 60, height: 12 }, color: false });
    expect(writes.join('')).toContain('overview'); // initial paint
    stdin.emit('data', Buffer.from('q'));
    await done; // resolves
    expect(writes.join('')).toContain('\x1b[?1049l'); // exited alt screen on teardown
  });

  it('repaints when a bus event arrives', async () => {
    const { stdin, stdout, writes } = fakeIO();
    const bus = createBus({ size: 100 });
    const adapters = { pshed: { status: () => ({ running: [], jobs: {} }) } };
    const done = runTui({ bus, adapters, stdin, stdout, size: { width: 60, height: 12 }, color: false });
    const before = writes.length;
    bus.push({ ts: 2, plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0', data: {} });
    await new Promise((r) => setImmediate(r)); // let the throttled paint flush
    expect(writes.length).toBeGreaterThan(before);
    stdin.emit('data', Buffer.from('q'));
    await done;
  });

  it('does not paint after teardown when a bus event races quit', async () => {
    const { stdin, stdout, writes } = fakeIO();
    const bus = createBus({ size: 100 });
    const adapters = { pshed: { status: () => ({ running: [], jobs: {} }) } };
    const done = runTui({ bus, adapters, stdin, stdout, size: { width: 60, height: 12 }, color: false });
    bus.push({ ts: 3, plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0', data: {} }); // arms setImmediate(paint)
    stdin.emit('data', Buffer.from('q')); // teardown runs synchronously before the scheduled paint
    const afterQuit = writes.length;
    await done;
    await new Promise((r) => setImmediate(r)); // let any stale scheduled paint attempt run
    expect(writes.length).toBe(afterQuit); // no extra frame written post-teardown
  });
});
