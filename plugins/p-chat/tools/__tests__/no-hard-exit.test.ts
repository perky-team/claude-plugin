import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_SRC = readFileSync(join(process.cwd(), 'plugins/p-chat/tools/pchat.mjs'), 'utf-8');

/**
 * Regression guard for the Windows crash: `process.exit()` while undici still holds a
 * keep-alive socket from an earlier Bot API call aborts the process with a libuv assert
 * (`!(handle->flags & UV_HANDLE_CLOSING)`) and exit code 3221226505. Any command that
 * calls the API twice hits it — `guard` does getUpdates + sendMessage — and p-shed reads
 * that code as a broken job instead of the 0 / 75 guard contract.
 *
 * The e2e suite covers the behaviour; this file pins the mechanism, because a future
 * "tidy-up" that reintroduces process.exit() would look harmless in review.
 */
describe('pchat never hard-exits', () => {
  it('the CLI contains no process.exit() call', () => {
    const hits = CLI_SRC.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /process\.exit\s*\(/.test(line) && !line.startsWith('//') && !line.startsWith('*'));
    expect(hits, `use process.exitCode instead:\n${hits.map((h) => `  ${h.n}: ${h.line}`).join('\n')}`).toEqual([]);
  });

  it('exits are set through process.exitCode', () => {
    expect(CLI_SRC).toMatch(/process\.exitCode = exitCode/);
  });

  it('every emitJson / die call site returns, since they no longer stop execution', () => {
    const offenders = CLI_SRC.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\b(emitJson|die)\s*\(/.test(line))
      .filter(({ line }) => !line.startsWith('export function'))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
      // Control flow is kept when the call is returned — either at the start of the line
      // or after a guard, as in `if (cond) return die(...)`. A bare call falls through.
      .filter(({ line }) => !/\breturn\s+(emitJson|die)\s*\(/.test(line));
    expect(offenders, `these calls would fall through:\n${offenders.map((h) => `  ${h.n}: ${h.line}`).join('\n')}`).toEqual([]);
  });
});
