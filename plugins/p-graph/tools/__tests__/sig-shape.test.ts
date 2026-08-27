import { describe, it, expect } from 'vitest';
import { sigShape } from '../lib/sig-shape.mjs';

describe('sigShape', () => {
  it('reads a Go interface method line', () => {
    expect(sigShape('ServeHTTP(http.ResponseWriter, *http.Request) error', 'ServeHTTP'))
      .toEqual({ params: 2, hasResult: true });
  });

  it('reads a Go method declaration and skips the receiver group', () => {
    expect(sigShape('func (h *metricsInstrumentedRoute) ServeHTTP(w http.ResponseWriter, r *http.Request) error {', 'ServeHTTP'))
      .toEqual({ params: 2, hasResult: true });
  });

  // The three real shapes this exists to tell apart, all from caddy.
  it('separates the three ServeHTTP contracts in caddy', () => {
    const iface = sigShape('ServeHTTP(http.ResponseWriter, *http.Request) error', 'ServeHTTP');
    const middleware = sigShape('ServeHTTP(http.ResponseWriter, *http.Request, Handler) error', 'ServeHTTP');
    const stdlib = sigShape('func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {', 'ServeHTTP');
    expect(iface).toEqual({ params: 2, hasResult: true });
    expect(middleware).toEqual({ params: 3, hasResult: true });
    expect(stdlib).toEqual({ params: 2, hasResult: false });
  });

  it('counts a nested parameter list as one parameter', () => {
    expect(sigShape('Walk(fn func(string, int) error) error', 'Walk'))
      .toEqual({ params: 1, hasResult: true });
  });

  it('counts a map or generic type as one parameter', () => {
    expect(sigShape('Set(m map[string]string, keys []string) error', 'Set'))
      .toEqual({ params: 2, hasResult: true });
  });

  it('reads a parenthesised result list as a result', () => {
    expect(sigShape('Get(key string) ([]byte, error)', 'Get'))
      .toEqual({ params: 1, hasResult: true });
  });

  it('reads no parameters and no result', () => {
    expect(sigShape('Reset()', 'Reset')).toEqual({ params: 0, hasResult: false });
  });

  it('returns null when the line holds no parameter list for that name', () => {
    expect(sigShape('type Handler interface {', 'ServeHTTP')).toBeNull();
    expect(sigShape('', 'ServeHTTP')).toBeNull();
    expect(sigShape(null, 'ServeHTTP')).toBeNull();
  });

  // A one-line Go method body reads as "no result" even when it has
  // statements inside it. The body is not a result type.
  it('treats a one-line method body as no result, not as a result', () => {
    expect(sigShape('func (c *Cache) Close() {}', 'Close'))
      .toEqual({ params: 0, hasResult: false });
    expect(sigShape(
      'func (w *Wrapper) ServeHTTP(rw http.ResponseWriter, r *http.Request) { w.Inner.ServeHTTP(rw, r) }',
      'ServeHTTP',
    )).toEqual({ params: 2, hasResult: false });
  });

  it('strips a trailing "//" comment before deciding there is no result', () => {
    expect(sigShape('Reset() // resets internal state', 'Reset'))
      .toEqual({ params: 0, hasResult: false });
  });

  // The comment must be stripped before the brace is cut, not after.
  // Cutting the brace first would leave "// uses ", which is not empty
  // and would wrongly read as a result.
  it('strips the comment first, even when the comment mentions a brace', () => {
    expect(sigShape('Reset() // uses {}', 'Reset'))
      .toEqual({ params: 0, hasResult: false });
  });

  // A real result type can itself contain a brace. Cutting at the first
  // "{" must not eat into these — there is text left before the brace.
  it('still reads a struct result type that contains a brace', () => {
    expect(sigShape('func f() struct{ A int } {', 'f'))
      .toEqual({ params: 0, hasResult: true });
    expect(sigShape('func f() map[string]struct{} {', 'f'))
      .toEqual({ params: 0, hasResult: true });
  });
});
