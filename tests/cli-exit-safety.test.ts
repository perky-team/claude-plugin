import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One invariant, learned the hard way in p-chat: a CLI must not combine
 * `process.exit()` with the global `fetch`.
 *
 * `fetch` is undici, which keeps a socket pool alive after a response resolves. Exiting
 * hard while that pool is tearing down aborts the process on Windows with a libuv
 * assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) and exit code
 * 3221226505 — after the command has already done its work and printed correct output.
 * Two requests in one run are enough to trigger it. Anything reading the exit code (in
 * this repo, p-shed reading a guard's 0 / 75) sees a crash instead of the contract.
 *
 * Two escapes exist, and each plugin may pick either:
 *   1. no `process.exit()` — set `process.exitCode` and let the loop drain (p-chat)
 *   2. no global `fetch` — `node:https` with a per-request `keepAlive: false` agent,
 *      which closes the socket before the exit (p-wiki, p-tasks)
 *
 * This test fails when a plugin has neither, which is the only combination that
 * crashes. It cannot be checked by the CLI suites: they inject a fake transport, so no
 * real socket is ever open when the process exits.
 */

const PLUGINS_DIR = 'plugins';

/** Runtime .mjs files under a plugin's tools/, excluding tests and vendored code. */
function runtimeSources(pluginDir: string): string[] {
  const toolsDir = join(pluginDir, 'tools');
  if (!existsSync(toolsDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'vendor' || entry === 'node_modules') continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith('.mjs')) out.push(abs);
    }
  };
  walk(toolsDir);
  return out;
}

/** Strip line comments and block comments so prose about the rule never counts as a use. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const plugins = readdirSync(PLUGINS_DIR).filter((p) => runtimeSources(join(PLUGINS_DIR, p)).length > 0);

describe('CLI exit safety: never process.exit() with global fetch', () => {
  it('finds plugins with a bundled CLI to check', () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    it(`${plugin} picks one of the two safe options`, () => {
      const files = runtimeSources(join(PLUGINS_DIR, plugin));
      const hardExits: string[] = [];
      const fetchUses: string[] = [];

      for (const file of files) {
        const code = stripComments(readFileSync(file, 'utf-8'));
        const rel = file.replace(/\\/g, '/');
        code.split('\n').forEach((line, i) => {
          if (/\bprocess\.exit\s*\(/.test(line)) hardExits.push(`${rel}:${i + 1}`);
          // Global fetch only: a `transport`/`fetchFn` parameter that a caller supplies
          // is the injected seam, not undici.
          if (/(^|[^.\w])fetch\s*\(/.test(line) && !/\bfetchFn\b|\btransport\b/.test(line)) {
            fetchUses.push(`${rel}:${i + 1}`);
          }
          if (/fetchFn\s*=\s*fetch\b/.test(line)) fetchUses.push(`${rel}:${i + 1}`);
        });
      }

      const unsafe = hardExits.length > 0 && fetchUses.length > 0;
      expect(
        unsafe,
        `${plugin} mixes process.exit() with the global fetch — on Windows that aborts the ` +
          `process (UV_HANDLE_CLOSING) once two requests share undici's socket pool.\n` +
          `  process.exit(): ${hardExits.join(', ')}\n` +
          `  fetch: ${fetchUses.join(', ')}\n` +
          `Fix by dropping either one: set process.exitCode instead of exiting, or use ` +
          `node:https with a per-request keepAlive:false agent.`,
      ).toBe(false);
    });
  }
});
