import { describe, expect, it } from 'vitest';
import { markdownToAdf, adfToMarkdown } from '../lib/confluence/adf.mjs';

describe('markdownToAdf', () => {
  it('produces an empty doc for empty input', () => {
    expect(markdownToAdf('')).toEqual({ type: 'doc', version: 1, content: [] });
  });

  it('h1 → heading level 1', () => {
    expect(markdownToAdf('# Foo')).toEqual({
      type: 'doc', version: 1,
      content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }],
    });
  });

  it('paragraph with bold and link', () => {
    const r = markdownToAdf('Hello **world** and [me](https://x).');
    expect(r.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'me', marks: [{ type: 'link', attrs: { href: 'https://x' } }] },
        { type: 'text', text: '.' },
      ],
    });
  });

  it('unordered list with inline code', () => {
    const r = markdownToAdf('- foo `bar`\n- baz');
    expect(r.content[0]).toMatchObject({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'foo ' },
          { type: 'text', text: 'bar', marks: [{ type: 'code' }] },
        ] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'baz' }] }] },
      ],
    });
  });

  it('fenced code block with language', () => {
    const r = markdownToAdf('```js\nconst x=1;\n```');
    expect(r.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: 'const x=1;' }],
    });
  });

  it('blockquote for conflict callout', () => {
    const r = markdownToAdf('> Conflict: A says X.');
    expect(r.content[0]).toMatchObject({
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Conflict: A says X.' }] }],
    });
  });
});

describe('adfToMarkdown', () => {
  it('empty doc → empty string', () => {
    expect(adfToMarkdown({ type: 'doc', version: 1, content: [] })).toBe('');
  });

  it('heading + paragraph round-trips on canonical form', () => {
    const md = '# Foo\n\nHello **world**.';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it('bullet list canonicalizes to `-` marker', () => {
    const adf = markdownToAdf('* foo\n* bar');
    expect(adfToMarkdown(adf)).toBe('- foo\n- bar');
  });

  it('code block preserves language', () => {
    const md = '```js\nconst x=1;\n```';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });

  it('link inline reconstructs', () => {
    const md = 'See [docs](https://x).';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
