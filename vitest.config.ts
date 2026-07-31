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
  },
});
