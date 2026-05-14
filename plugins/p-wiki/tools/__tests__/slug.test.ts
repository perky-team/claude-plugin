import { describe, expect, it } from 'vitest';
import { kebab, withDateSuffix, stripDatePrefix } from '../lib/slug.mjs';

describe('slug.kebab', () => {
  it('lowercases and replaces spaces', () => {
    expect(kebab('Hello World')).toBe('hello-world');
  });
  it('strips punctuation', () => {
    expect(kebab(`Kafka's "partitioning"!`)).toBe('kafkas-partitioning');
  });
  it('collapses repeats', () => {
    expect(kebab('a  b   c')).toBe('a-b-c');
    expect(kebab('a---b')).toBe('a-b');
  });
  it('trims leading/trailing dashes', () => {
    expect(kebab(' -foo- ')).toBe('foo');
  });
  it('handles all-non-ascii gracefully', () => {
    expect(kebab('кафка темы')).toMatch(/^[a-z0-9-]*$/);
  });
});

describe('slug.withDateSuffix', () => {
  it('appends YYYY-MM-DD', () => {
    expect(withDateSuffix('foo', '2026-05-14')).toBe('foo-2026-05-14');
  });
});

describe('slug.stripDatePrefix', () => {
  it('removes leading YYYY-MM-DD-', () => {
    expect(stripDatePrefix('2026-05-14-hello')).toBe('hello');
  });
  it('leaves slugs without date prefix untouched', () => {
    expect(stripDatePrefix('hello')).toBe('hello');
  });
});
