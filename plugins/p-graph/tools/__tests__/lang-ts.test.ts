import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const SRC = `
import { helper } from './util';
export class Service {
  run() { return helper(this.calc()); }
  calc() { return 1; }
}
function top() { new Service().run(); }
`;

describe('ts extraction', () => {
  it('captures class, methods, function, calls, import', async () => {
    const cfg = resolveLang('svc.ts');
    const { nodes, edges } = await extract({ file: 'svc.ts', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: SRC });
    const names = nodes.map((n) => n.qname).sort();
    expect(names).toContain('Service');
    expect(names).toContain('Service.run');
    expect(names).toContain('Service.calc');
    expect(names).toContain('top');
    expect(edges.some((e) => e.kind === 'call' && e.dst_name === 'helper')).toBe(true);
    expect(edges.some((e) => e.kind === 'import' && /util/.test(e.dst_name))).toBe(true);
  }, 20000);
});
