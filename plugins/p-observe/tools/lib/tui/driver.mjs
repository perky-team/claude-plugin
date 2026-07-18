import { collectStatus } from '../core.mjs';
import { ENTER_ALT, EXIT_ALT, HIDE_CURSOR, SHOW_CURSOR, HOME, CLEAR } from './ansi.mjs';
import { buildTabs, initState, ingest } from './state.mjs';
import { reduce } from './reducer.mjs';
import { decodeKeys } from './keys.mjs';
import { render } from './layout/frame.mjs';

export function runTui(io) {
  const { bus, adapters, stdin, stdout, color = true } = io;
  let size = io.size ?? { width: stdout.columns || 80, height: stdout.rows || 24 };
  let state = initState({ tabs: buildTabs(adapters), width: size.width, height: size.height });
  let scheduled = false;
  let unsub = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  function paint() {
    if (torn) return;
    scheduled = false;
    state = ingest(state, {
      events: bus.snapshot(),
      status: collectStatus(adapters),
      width: size.width,
      height: size.height,
    });
    stdout.write(HOME + render(state, { color }).join('\n'));
  }
  function schedule() { if (!scheduled) { scheduled = true; setImmediate(paint); } }

  function onData(chunk) {
    for (const tok of decodeKeys(chunk.toString('utf-8'))) {
      state = reduce(state, tok);
      if (state.quit) { teardown(); resolveDone(); return; }
    }
    paint();
  }
  function onResize() {
    size = { width: stdout.columns || size.width, height: stdout.rows || size.height };
    paint();
  }

  let torn = false;
  function teardown() {
    if (torn) return; torn = true;
    if (unsub) unsub();
    stdin.removeListener('data', onData);
    if (stdout.removeListener) stdout.removeListener('resize', onResize);
    try { if (stdin.setRawMode) stdin.setRawMode(false); } catch { /* not a TTY */ }
    if (stdin.pause) stdin.pause();
    stdout.write(SHOW_CURSOR + EXIT_ALT);
  }

  // setup
  try { if (stdin.setRawMode) stdin.setRawMode(true); } catch { /* not a TTY */ }
  if (stdin.resume) stdin.resume();
  stdout.write(ENTER_ALT + HIDE_CURSOR + CLEAR);
  stdin.on('data', onData);
  if (stdout.on) stdout.on('resize', onResize);
  unsub = bus.subscribe(schedule);
  paint();

  return done;
}
