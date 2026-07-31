import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS = join(process.cwd(), 'plugins/p-chat/tools');

/** Every runtime .mjs under tools/, tests excluded — lib/ counts as much as the entry. */
function runtimeFiles(dir = TOOLS): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'vendor' || entry === 'node_modules') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...runtimeFiles(abs));
    else if (entry.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

const SOURCES = runtimeFiles().map((path) => ({ path, src: readFileSync(path, 'utf-8') }));
const CLI_SRC = readFileSync(join(TOOLS, 'pchat.mjs'), 'utf-8');

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
  it('finds the runtime sources it is meant to check', () => {
    expect(SOURCES.map((s) => s.path.replace(/\\/g, '/'))).toContain(
      join(TOOLS, 'pchat.mjs').replace(/\\/g, '/'),
    );
    expect(SOURCES.length).toBeGreaterThan(1); // lib/ files too, not just the entry point
  });

  it('no runtime file contains a process.exit() call', () => {
    const hits: string[] = [];
    for (const { path, src } of SOURCES) {
      src.split('\n').forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith('//') || line.startsWith('*')) return;
        if (/process\.exit\s*\(/.test(line)) hits.push(`${path.replace(/\\/g, '/')}:${i + 1}: ${line}`);
      });
    }
    expect(hits, `use process.exitCode instead:\n${hits.join('\n')}`).toEqual([]);
  });

  it('exits are set through process.exitCode', () => {
    expect(CLI_SRC).toMatch(/process\.exitCode = exitCode/);
  });

  it('every emitJson / die call site returns, since they no longer stop execution', () => {
    const offenders: string[] = [];
    for (const { path, src } of SOURCES) {
      src.split('\n').forEach((raw, i) => {
        const line = raw.trim();
        if (!/\b(emitJson|die)\s*\(/.test(line)) return;
        if (line.startsWith('export function') || line.startsWith('//') || line.startsWith('*')) return;
        // Control flow is kept when the call is returned — either at the start of the line
        // or after a guard, as in `if (cond) return die(...)`. A bare call falls through.
        if (/\breturn\s+(emitJson|die)\s*\(/.test(line)) return;
        offenders.push(`${path.replace(/\\/g, '/')}:${i + 1}: ${line}`);
      });
    }
    expect(offenders, `these calls would fall through:\n${offenders.join('\n')}`).toEqual([]);
  });
});
