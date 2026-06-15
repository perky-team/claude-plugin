import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';

describe('parse registry', () => {
  it('maps extensions to lang config', () => {
    expect(resolveLang('a.ts')).toMatchObject({ lang: 'ts', langId: 'typescript' });
    expect(resolveLang('a.tsx')).toMatchObject({ langId: 'tsx' });
    expect(resolveLang('a.go')).toMatchObject({ lang: 'go', langId: 'go' });
    expect(resolveLang('a.cpp')).toMatchObject({ lang: 'cpp', langId: 'cpp' });
    expect(resolveLang('a.py')).toMatchObject({ lang: 'py', langId: 'python' });
    expect(resolveLang('a.txt')).toBeNull();
  });
});
