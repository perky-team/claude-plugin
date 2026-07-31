import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

function stripShebang(): Plugin {
  return {
    name: 'strip-shebang',
    transform(code, id) {
      if (id.endsWith('.mjs') && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*\n/, ''), map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [stripShebang()],
  test: {
    include: [
      'tests/**/*.test.ts',
      'plugins/**/tools/__tests__/**/*.test.ts',
    ],
    // Keeps the worker's event loop breathing between synchronous e2e tests — see
    // vitest.setup.ts for why the run otherwise dies on an onTaskUpdate RPC timeout.
    setupFiles: ['./vitest.setup.ts'],
    // Always leave a machine-readable record of the last run next to the console output.
    // A flaky e2e test that fails once in a dozen runs is only worth chasing if you know
    // WHICH test failed, and the terminal scrollback of a 200-file run does not survive
    // being piped or reused. The file is gitignored and overwritten every run.
    reporters: [
      'default',
      ['json', { outputFile: '.vitest-last-run.json' }],
    ],
  },
});
