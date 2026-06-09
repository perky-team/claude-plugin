import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '../lib/fm.mjs';

const PAGE = `---
id: foo
type: concept
title: Foo
created: 2026-05-14
updated: 2026-05-14
status: active
tags: [a, b]
sources: []
---

# Foo

Body line.
`;

describe('fm.parseFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const { frontmatter, body } = parseFrontmatter(PAGE);
    expect(frontmatter).toEqual({
      id: 'foo', type: 'concept', title: 'Foo',
      created: '2026-05-14', updated: '2026-05-14',
      status: 'active', tags: ['a', 'b'], sources: [],
    });
    expect(body).toBe('\n# Foo\n\nBody line.\n');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseFrontmatter('# no frontmatter\n')).toThrow(/frontmatter/);
  });

  it('throws on unterminated frontmatter', () => {
    expect(() => parseFrontmatter('---\nid: foo\n# nope\n')).toThrow(/frontmatter/);
  });

  it('parses a CRLF file (Windows / git autocrlf) instead of silently failing', () => {
    const crlf = PAGE.replace(/\n/g, '\r\n');
    const { frontmatter, body } = parseFrontmatter(crlf);
    expect(frontmatter.id).toBe('foo');
    expect(frontmatter.type).toBe('concept');
    expect(body).toBe('\n# Foo\n\nBody line.\n');
  });
});

describe('fm.serializeFrontmatter', () => {
  it('round-trips with parseFrontmatter', () => {
    const { frontmatter, body } = parseFrontmatter(PAGE);
    const out = serializeFrontmatter(frontmatter, body);
    expect(parseFrontmatter(out).frontmatter).toEqual(frontmatter);
    expect(parseFrontmatter(out).body).toBe(body);
  });
});
