import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'plugins/**/tools/__tests__/**/*.test.ts',
    ],
  },
});
