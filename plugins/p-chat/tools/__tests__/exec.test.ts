import { describe, expect, it } from 'vitest';
import { runShell } from '../lib/exec.mjs';

describe('runShell', () => {
  it('captures stdout and exit code', async () => {
    const r = await runShell('node -e "console.log(\'ok-line\')"', {});
    expect(r.exit).toBe(0);
    expect(r.out).toContain('ok-line');
  });

  it('reports non-zero exits with stderr', async () => {
    const r = await runShell('node -e "console.error(\'bad\');process.exit(3)"', {});
    expect(r.exit).toBe(3);
    expect(r.err).toContain('bad');
  });

  it('kills a hung command at the timeout', async () => {
    const r = await runShell('node -e "setTimeout(()=>{},10000)"', { timeoutSec: 0.4 });
    expect(r.timedOut).toBe(true);
    expect(r.exit).toBeNull();
  }, 10000);
});
