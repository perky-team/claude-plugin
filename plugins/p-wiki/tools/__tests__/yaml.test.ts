import { describe, expect, it } from 'vitest';
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs';

describe('yaml parser', () => {
  it('parses scalar fields', () => {
    const src = 'id: foo\ntitle: Hello\ncompiled: false\nsource-url: null\n';
    expect(parseYaml(src)).toEqual({
      id: 'foo', title: 'Hello', compiled: false, 'source-url': null,
    });
  });

  it('parses inline string arrays', () => {
    expect(parseYaml('tags: [a, b, c]\n')).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('parses block string arrays', () => {
    const src = 'sources:\n  - foo.md\n  - bar.md\n';
    expect(parseYaml(src)).toEqual({ sources: ['foo.md', 'bar.md'] });
  });

  it('parses empty arrays', () => {
    expect(parseYaml('tags: []\n')).toEqual({ tags: [] });
  });

  it('parses ISO date as string', () => {
    expect(parseYaml('created: 2026-05-14\n')).toEqual({ created: '2026-05-14' });
  });

  it('parses quoted strings preserving special chars', () => {
    expect(parseYaml('question: "What is X?"\n')).toEqual({ question: 'What is X?' });
  });
});

describe('yaml stringifier', () => {
  it('round-trips a typical concept frontmatter', () => {
    const obj = {
      id: 'kafka',
      type: 'concept',
      title: 'Kafka',
      created: '2026-05-14',
      updated: '2026-05-14',
      status: 'active',
      tags: ['streaming', 'queues'],
      sources: ['raw/articles/kafka.md'],
    };
    expect(parseYaml(stringifyYaml(obj))).toEqual(obj);
  });

  it('uses block form for non-empty arrays, inline for empty', () => {
    const out = stringifyYaml({ tags: ['a', 'b'], sources: [] });
    expect(out).toContain('tags:\n  - a\n  - b');
    expect(out).toContain('sources: []');
  });

  it('outputs null and booleans as YAML keywords', () => {
    const out = stringifyYaml({ 'source-url': null, compiled: false });
    expect(out).toMatch(/source-url: null/);
    expect(out).toMatch(/compiled: false/);
  });

  it('round-trips a title with embedded double quotes', () => {
    const obj = { title: 'The "Twelve-Factor" App' };
    expect(parseYaml(stringifyYaml(obj))).toEqual(obj);
    // And stays stable across repeated serialize→parse (no backslash accumulation).
    const once = parseYaml(stringifyYaml(obj));
    expect(parseYaml(stringifyYaml(once))).toEqual(obj);
  });

  it('round-trips a bracketed string as a string, not an array', () => {
    const obj = { title: '[WIP]' };
    expect(parseYaml(stringifyYaml(obj))).toEqual(obj);
  });

  it('round-trips an all-digit string without coercing to a number', () => {
    const obj = { id: '2024' };
    expect(parseYaml(stringifyYaml(obj))).toEqual(obj);
  });

  it('round-trips strings that look like YAML keywords', () => {
    const obj = { title: 'true', status: 'null' };
    expect(parseYaml(stringifyYaml(obj))).toEqual(obj);
  });
});
