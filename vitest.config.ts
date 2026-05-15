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
  },
});
