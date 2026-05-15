import { describe, expect, it } from 'vitest';
import {
  escapeRegex,
  findFirstMatch,
  insertLinkAt,
  computeRelPath,
} from '../lib/backlinks.mjs';

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('Node.js')).toBe('Node\\.js');
    expect(escapeRegex('C++')).toBe('C\\+\\+');
    expect(escapeRegex('foo (bar)')).toBe('foo \\(bar\\)');
  });
});

describe('findFirstMatch', () => {
  it('finds a plain word with whitespace boundaries', () => {
    const r = findFirstMatch('The kafka topic\n', 'kafka');
    expect(r).not.toBeNull();
    expect(r!.index).toBe(4);
    expect(r!.length).toBe(5);
    expect(r!.line).toBe(1);
    expect(r!.col).toBe(5);
  });

  it('respects whole-word boundary (ASCII)', () => {
    expect(findFirstMatch('kafkaesque vibes\n', 'kafka')).toBeNull();
  });

  it('respects whole-word boundary (Cyrillic)', () => {
    // "Кафкианский" must not match "Кафка"
    expect(findFirstMatch('Это Кафкианский день\n', 'Кафка')).toBeNull();
  });

  it('matches Cyrillic title with non-letter boundaries', () => {
    const r = findFirstMatch('Что такое Кафка? Это система.\n', 'Кафка');
    expect(r).not.toBeNull();
    expect(r!.line).toBe(1);
  });

  it('is case-sensitive', () => {
    expect(findFirstMatch('Kafka rules. kafka.\n', 'kafka')).toMatchObject({ line: 1 });
    const r = findFirstMatch('Kafka rules. kafka.\n', 'kafka');
    // First "kafka" (lowercase) is at index 13
    expect(r!.index).toBe(13);
  });

  it('skips matches inside an inline-code span', () => {
    const r = findFirstMatch('Use `kafka` everywhere\n', 'kafka');
    expect(r).toBeNull();
  });

  it('skips matches inside a fenced code block', () => {
    const body = 'Intro\n```\nkafka inside fence\n```\nAfter\n';
    expect(findFirstMatch(body, 'kafka')).toBeNull();
  });

  it('skips matches inside an inline markdown link [text](url)', () => {
    const r = findFirstMatch('See [kafka docs](./kafka.md) for details\n', 'kafka');
    expect(r).toBeNull();
  });

  it('skips matches inside a reference-style link [text][id]', () => {
    const r = findFirstMatch('See [kafka][1] for details\n', 'kafka');
    expect(r).toBeNull();
  });

  it('skips matches inside a shortcut reference [text]', () => {
    const r = findFirstMatch('See [kafka] for details\n', 'kafka');
    expect(r).toBeNull();
  });

  it('returns only the FIRST qualifying match', () => {
    const body = 'A kafka here. Another kafka there.\n';
    const r = findFirstMatch(body, 'kafka');
    expect(r!.index).toBe(2);
  });

  it('handles title with regex metacharacters (Node.js)', () => {
    const r = findFirstMatch('Built on Node.js platform.\n', 'Node.js');
    expect(r).not.toBeNull();
    expect(r!.index).toBe(9);
  });

  it('returns null when title is absent', () => {
    expect(findFirstMatch('Nothing to see here.\n', 'kafka')).toBeNull();
  });

  it('computes 1-based line and column', () => {
    const body = 'line 1\nline 2 with kafka here\nline 3\n';
    const r = findFirstMatch(body, 'kafka');
    expect(r!.line).toBe(2);
    expect(r!.col).toBe(13);
  });
});

describe('insertLinkAt', () => {
  it('replaces the matched slice with the link markdown', () => {
    const body = 'See kafka here.';
    const r = findFirstMatch(body, 'kafka')!;
    const out = insertLinkAt(body, r, '[kafka](../concept/kafka.md)');
    expect(out).toBe('See [kafka](../concept/kafka.md) here.');
  });
});

describe('computeRelPath', () => {
  it('computes relative path between siblings', () => {
    expect(computeRelPath(
      'docs/wiki/pages/concept/a.md',
      'docs/wiki/pages/concept/b.md',
    )).toBe('b.md');
  });

  it('computes relative path across type directories', () => {
    expect(computeRelPath(
      'docs/wiki/pages/source/x-summary.md',
      'docs/wiki/pages/concept/kafka.md',
    )).toBe('../concept/kafka.md');
  });

  it('computes relative path across deeper directories', () => {
    expect(computeRelPath(
      'docs/wiki/pages/queries/2026-05-15-foo.md',
      'docs/wiki/pages/concept/foo.md',
    )).toBe('../concept/foo.md');
  });
});
