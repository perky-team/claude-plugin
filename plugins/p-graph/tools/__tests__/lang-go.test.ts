import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const SRC = `package main
import "fmt"
type Server struct{}
func (s *Server) Run() { fmt.Println(helper()); s.calc() }
func (s *Server) calc() int { return len("x") }
func helper() int { return 1 }
func main() { (&Server{}).Run() }
`;

async function run(src = SRC) {
  const cfg = resolveLang('main.go');
  return extract({ file: 'main.go', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: src });
}

describe('go extraction', () => {
  it('captures struct, methods, func, call, import', async () => {
    const { nodes, edges } = await run();
    const names = nodes.map((n) => n.name).sort();
    expect(names).toContain('Server');
    expect(names).toContain('Run');
    expect(names).toContain('main');
    expect(edges.some((e) => e.kind === 'call')).toBe(true);
    expect(edges.some((e) => e.kind === 'import' && /fmt/.test(e.dst_name))).toBe(true);
  }, 20000);

  it('package-qualifies top-level symbols and receiver-qualifies methods', async () => {
    const { nodes } = await run();
    const qn = (name) => nodes.find((n) => n.name === name)?.qname;
    expect(qn('Server')).toBe('main.Server');
    expect(qn('helper')).toBe('main.helper');
    expect(qn('main')).toBe('main.main');
    expect(qn('Run')).toBe('main.Server.Run');
    expect(qn('calc')).toBe('main.Server.calc');
    // `name` stays bare for search/UX
    expect(nodes.find((n) => n.name === 'Run')?.name).toBe('Run');
  }, 20000);

  it('qualifies call targets: package selector, same-package plain, leaves method/builtin bare', async () => {
    const { edges } = await run();
    const calls = edges.filter((e) => e.kind === 'call').map((e) => e.dst_name);
    // imported package selector -> external, stays qualified (resolves to NULL later)
    expect(calls).toContain('fmt.Println');
    // same-package plain call -> package-qualified
    expect(calls).toContain('main.helper');
    // method call on a value/expr -> bare (receiver type unknown)
    expect(calls).toContain('calc'); // s.calc()
    expect(calls).toContain('Run');  // (&Server{}).Run()
    // builtin -> bare, never package-qualified
    expect(calls).toContain('len');
    expect(calls).not.toContain('main.len');
    expect(calls).not.toContain('main.calc');
  }, 20000);

  it('skips same-package qualification in files that use a dot-import', async () => {
    const { edges } = await run(`package main
import . "fmt"
func helper() {}
func main() { helper(); Println("x") }
`);
    const calls = edges.filter((e) => e.kind === 'call').map((e) => e.dst_name);
    // dot-import in the file -> a bare name may be from the dot-imported package,
    // so we keep it bare instead of mis-qualifying it as same-package.
    expect(calls).toContain('helper');
    expect(calls).toContain('Println');
    expect(calls).not.toContain('main.helper');
  }, 20000);
});
