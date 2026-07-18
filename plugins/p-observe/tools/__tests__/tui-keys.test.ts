import { describe, expect, it } from 'vitest';
import { decodeKeys } from '../lib/tui/keys.mjs';

describe('decodeKeys', () => {
  it('maps simple control keys', () => {
    expect(decodeKeys('\t')).toEqual(['tab']);
    expect(decodeKeys('\r')).toEqual(['enter']);
    expect(decodeKeys('\n')).toEqual(['enter']);
    expect(decodeKeys('\x7f')).toEqual(['backspace']);
    expect(decodeKeys('\x1b')).toEqual(['esc']);
    expect(decodeKeys('\x03')).toEqual(['ctrl-c']);
  });
  it('maps arrow escape sequences', () => {
    expect(decodeKeys('\x1b[A')).toEqual(['up']);
    expect(decodeKeys('\x1b[B')).toEqual(['down']);
  });
  it('maps digits and printable chars', () => {
    expect(decodeKeys('1')).toEqual(['digit:1']);
    expect(decodeKeys('j')).toEqual(['j']);
    expect(decodeKeys('x')).toEqual(['char:x']);
  });
  it('splits multi-key chunks', () => {
    expect(decodeKeys('jk')).toEqual(['j', 'k']);
  });
});
