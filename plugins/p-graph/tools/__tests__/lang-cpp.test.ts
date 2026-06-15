import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const SRC = `#include <cstdio>
class Server {
public:
  void run() { calc(); }
  int calc() { return 1; }
};
void main_loop() { Server s; s.run(); }
`;

describe('cpp extraction', () => {
  it('captures class, methods, function, call, include', async () => {
    const cfg = resolveLang('s.cpp');
    const { nodes, edges } = await extract({ file: 's.cpp', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: SRC });
    const names = nodes.map((n) => n.name).sort();
    expect(names).toContain('Server');
    expect(names).toContain('run');
    expect(names).toContain('main_loop');
    expect(edges.some((e) => e.kind === 'call')).toBe(true);
    expect(edges.some((e) => e.kind === 'include' && /cstdio/.test(e.dst_name))).toBe(true);
  }, 20000);
});
