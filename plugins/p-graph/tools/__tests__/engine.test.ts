import { describe, it, expect } from 'vitest';
import { loadLanguage, parseAndQuery } from '../lib/parse/engine.mjs';

describe('engine', () => {
  it('parses TS and returns query captures', async () => {
    const lang = await loadLanguage('typescript');
    const scm = '(function_declaration name: (identifier) @name) @def';
    const caps = await parseAndQuery(lang, scm, 'function foo() {}');
    const names = caps.filter((c) => c.name === 'name').map((c) => c.text);
    expect(names).toContain('foo');
  }, 20000);
});
