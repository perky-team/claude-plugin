import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

// Three methods in one interface, and one of them shares a name with a method on
// a concrete type. Both facts matter: the three must not collapse into one, and
// the interface's own methods must stay nested under the interface.
const SRC = `package store
type Store interface {
	Get(key string) ([]byte, error)
	Put(key string, value []byte) error
	Close() error
}
type File struct{}
func (f *File) Close() error { return nil }
`;

async function run(src = SRC) {
  const cfg = resolveLang('store.go');
  return extract({ file: 'store.go', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: src });
}

describe('go interface method sets', () => {
  it('records every method the interface declares, not only the first', async () => {
    const { nodes } = await run();
    const iface = nodes.find((n) => n.name === 'Store' && n.kind === 'interface');
    expect(iface).toBeTruthy();
    const members = nodes.filter((n) => n.container_id === iface.id).map((n) => n.name).sort();
    expect(members).toEqual(['Close', 'Get', 'Put']);
  }, 20000);

  it('gives each one its own line and its own signature', async () => {
    const { nodes } = await run();
    const iface = nodes.find((n) => n.name === 'Store' && n.kind === 'interface');
    const member = (name) => nodes.find((n) => n.container_id === iface.id && n.name === name);
    expect(member('Get').start_line).toBe(3);
    expect(member('Put').start_line).toBe(4);
    expect(member('Close').start_line).toBe(5);
    expect(member('Get').signature).toBe('Get(key string) ([]byte, error)');
    expect(member('Put').signature).toBe('Put(key string, value []byte) error');
    // The interface's own line must no longer be handed to its methods.
    expect(member('Get').signature).not.toContain('interface {');
  }, 20000);

  it('keeps the concrete method separate from the interface method of the same name', async () => {
    const { nodes } = await run();
    const closes = nodes.filter((n) => n.name === 'Close');
    expect(closes).toHaveLength(2);
    expect(closes.map((n) => n.qname).sort()).toEqual(['store.File.Close', 'store.Store.Close']);
  }, 20000);
});
