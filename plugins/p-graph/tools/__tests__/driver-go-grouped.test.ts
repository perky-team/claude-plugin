import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

async function run(src: string) {
  const cfg = resolveLang('x.go');
  return extract({ file: 'x.go', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: src });
}

describe('go grouped type declarations', () => {
  it('captures every spec in a grouped block (struct / interface / named type)', async () => {
    const { nodes } = await run(`package core
type (
	PipelineDoneError struct{ msg string }
	Reader interface{ Read() error }
	StateCode int
)
`);
    const byName = (n: string) => nodes.find((x) => x.name === n);
    expect(byName('PipelineDoneError')).toMatchObject({ kind: 'struct', qname: 'core.PipelineDoneError' });
    expect(byName('Reader')).toMatchObject({ kind: 'interface', qname: 'core.Reader' });
    expect(byName('StateCode')).toMatchObject({ kind: 'type', qname: 'core.StateCode' });
    // No spec duplicated onto another spec's name, and no mangled X.X nesting.
    expect(nodes.filter((n) => n.name === 'PipelineDoneError')).toHaveLength(1);
    expect(nodes.every((n) => !/\.(\w+)\.\1$/.test(n.qname))).toBe(true);
  }, 20000);

  it('resolves methods on grouped types to <pkg>.<Type>.<method>', async () => {
    const { nodes } = await run(`package core
type (
	PipelineDoneError struct{ msg string }
	InvalidActionError struct{ msg string }
)
func (e *PipelineDoneError) Error() string { return e.msg }
func (e *InvalidActionError) Unwrap() error { return nil }
`);
    const qn = (n: string) => nodes.find((x) => x.name === n)?.qname;
    expect(qn('Error')).toBe('core.PipelineDoneError.Error');
    expect(qn('Unwrap')).toBe('core.InvalidActionError.Unwrap');
    // The type nodes themselves survive (whole file was previously dropped).
    expect(qn('PipelineDoneError')).toBe('core.PipelineDoneError');
    expect(qn('InvalidActionError')).toBe('core.InvalidActionError');
  }, 20000);

  it('captures a type alias as a type node', async () => {
    const { nodes } = await run(`package data_handler
type DataHandlerError = core.DataHandlerError
`);
    expect(nodes.find((n) => n.name === 'DataHandlerError'))
      .toMatchObject({ kind: 'type', qname: 'data_handler.DataHandlerError' });
  }, 20000);

  it('a grouped block never loses the file\'s standalone funcs', async () => {
    const { nodes } = await run(`package svc
type (
	A struct{}
	B struct{}
)
func New() *A { return &A{} }
func helper() int { return 1 }
`);
    const qn = (n: string) => nodes.find((x) => x.name === n)?.qname;
    expect(qn('A')).toBe('svc.A');
    expect(qn('B')).toBe('svc.B');
    expect(qn('New')).toBe('svc.New');
    expect(qn('helper')).toBe('svc.helper');
  }, 20000);

  it('leaves standalone type declarations unchanged (no regression)', async () => {
    const { nodes } = await run(`package resolver
type PipelineDoneError struct{}
func (e *PipelineDoneError) Error() string { return "" }
`);
    expect(nodes.find((n) => n.name === 'PipelineDoneError'))
      .toMatchObject({ kind: 'struct', qname: 'resolver.PipelineDoneError' });
    expect(nodes.find((n) => n.name === 'Error')?.qname).toBe('resolver.PipelineDoneError.Error');
  }, 20000);
});
