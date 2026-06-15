import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const SRC = `package main
import "fmt"
type Server struct{}
func (s *Server) Run() { fmt.Println(s.calc()) }
func (s *Server) calc() int { return 1 }
func main() { (&Server{}).Run() }
`;

describe('go extraction', () => {
  it('captures struct, methods, func, call, import', async () => {
    const cfg = resolveLang('main.go');
    const { nodes, edges } = await extract({ file: 'main.go', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: SRC });
    const names = nodes.map((n) => n.name).sort();
    expect(names).toContain('Server');
    expect(names).toContain('Run');
    expect(names).toContain('main');
    expect(edges.some((e) => e.kind === 'call')).toBe(true);
    expect(edges.some((e) => e.kind === 'import' && /fmt/.test(e.dst_name))).toBe(true);
  }, 20000);
});
