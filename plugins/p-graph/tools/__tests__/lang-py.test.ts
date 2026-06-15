import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const SRC = `import os
class Service:
    def run(self):
        return self.calc()
    def calc(self):
        return 1
def top():
    Service().run()
`;

describe('py extraction', () => {
  it('captures class, methods, function, call, import', async () => {
    const cfg = resolveLang('s.py');
    const { nodes, edges } = await extract({ file: 's.py', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: SRC });
    const names = nodes.map((n) => n.qname).sort();
    expect(names).toContain('Service');
    expect(names).toContain('Service.run');
    expect(names).toContain('top');
    expect(edges.some((e) => e.kind === 'call')).toBe(true);
    expect(edges.some((e) => e.kind === 'import' && /os/.test(e.dst_name))).toBe(true);
  }, 20000);
});
