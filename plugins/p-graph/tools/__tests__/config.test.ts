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
  it('root-only ignores do not skip same-named source dirs nested deeper', () => {
    // build/out/dist only ignored at the repo root...
    expect(isIgnored('build/x.ts', [])).toBe(true);
    expect(isIgnored('out/x.go', [])).toBe(true);
    // ...not when they are a real source subdirectory.
    expect(isIgnored('src/build/api.ts', [])).toBe(false);
    expect(isIgnored('app/out/handler.go', [])).toBe(false);
  });
  it('node_modules is ignored at any depth', () => {
    expect(isIgnored('node_modules/x.js', [])).toBe(true);
    expect(isIgnored('packages/a/node_modules/x.js', [])).toBe(true);
  });
  it('multi-segment extra patterns match as a prefix', () => {
    expect(isIgnored('src/legacy/x.ts', ['src/legacy'])).toBe(true);
    expect(isIgnored('src/active/x.ts', ['src/legacy'])).toBe(false);
  });
});
