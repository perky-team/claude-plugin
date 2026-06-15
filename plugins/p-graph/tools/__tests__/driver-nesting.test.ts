import { describe, it, expect } from 'vitest';
import { extract } from '../lib/parse/driver.mjs';

describe('driver containment is column-aware', () => {
  it('two arrow functions on one line are siblings, not nested, no undefined qname', async () => {
    const scm = `(lexical_declaration (variable_declarator name: (identifier) @name (arrow_function))) @definition.function`;
    const { nodes } = await extract({ file: 'x.js', lang: 'js', langId: 'javascript', scm, source: 'const a = () => {}; const b = () => {};' });
    const qnames = nodes.map((n) => n.qname).sort();
    expect(qnames).toEqual(['a', 'b']);
    expect(qnames.some((q) => q.includes('undefined'))).toBe(false);
  }, 20000);
});
