import { describe, it, expect } from 'vitest';
import { toPosix, defaultConfig, isIgnored, DEFAULT_IGNORES } from '../lib/config.mjs';

describe('config', () => {
  it('normalizes Windows separators to POSIX', () => {
    expect(toPosix('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(toPosix('src/a/b.ts')).toBe('src/a/b.ts');
  });
  it('default config selects local destination', () => {
    expect(defaultConfig().destination).toBe('local');
  });
  it('default ignores cover vendor dirs even with empty patterns', () => {
    expect(DEFAULT_IGNORES).toContain('node_modules');
    expect(isIgnored('node_modules/x/y.js', [])).toBe(true);
    expect(isIgnored('.pgraph/graph.db', [])).toBe(true);
    expect(isIgnored('src/app.ts', [])).toBe(false);
  });
  it('extra patterns add to defaults', () => {
    expect(isIgnored('gen/out.ts', ['gen'])).toBe(true);
    expect(isIgnored('src/out.ts', ['gen'])).toBe(false);
  });
});
