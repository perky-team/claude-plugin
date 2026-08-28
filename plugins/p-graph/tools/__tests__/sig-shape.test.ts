import { describe, it, expect } from 'vitest';
import { sigShape } from '../lib/sig-shape.mjs';

describe('sigShape', () => {
  it('reads a Go interface method line', () => {
    expect(sigShape('ServeHTTP(http.ResponseWriter, *http.Request) error', 'ServeHTTP'))
      .toEqual({ params: 2, hasResult: true, variadic: false });
  });

  it('reads a Go method declaration and skips the receiver group', () => {
    expect(sigShape('func (h *metricsInstrumentedRoute) ServeHTTP(w http.ResponseWriter, r *http.Request) error {', 'ServeHTTP'))
      .toEqual({ params: 2, hasResult: true, variadic: false });
  });

  // The three real shapes this exists to tell apart, all from caddy.
  it('separates the three ServeHTTP contracts in caddy', () => {
    const iface = sigShape('ServeHTTP(http.ResponseWriter, *http.Request) error', 'ServeHTTP');
    const middleware = sigShape('ServeHTTP(http.ResponseWriter, *http.Request, Handler) error', 'ServeHTTP');
    const stdlib = sigShape('func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {', 'ServeHTTP');
    expect(iface).toEqual({ params: 2, hasResult: true, variadic: false });
    expect(middleware).toEqual({ params: 3, hasResult: true, variadic: false });
    expect(stdlib).toEqual({ params: 2, hasResult: false, variadic: false });
  });

  it('counts a nested parameter list as one parameter', () => {
    expect(sigShape('Walk(fn func(string, int) error) error', 'Walk'))
      .toEqual({ params: 1, hasResult: true, variadic: false });
  });

  it('counts a map or generic type as one parameter', () => {
    expect(sigShape('Set(m map[string]string, keys []string) error', 'Set'))
      .toEqual({ params: 2, hasResult: true, variadic: false });
  });

  it('reads a parenthesised result list as a result', () => {
    expect(sigShape('Get(key string) ([]byte, error)', 'Get'))
      .toEqual({ params: 1, hasResult: true, variadic: false });
  });

  it('reads no parameters and no result', () => {
    expect(sigShape('Reset()', 'Reset')).toEqual({ params: 0, hasResult: false, variadic: false });
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
      .toEqual({ params: 0, hasResult: false, variadic: false });
    expect(sigShape(
      'func (w *Wrapper) ServeHTTP(rw http.ResponseWriter, r *http.Request) { w.Inner.ServeHTTP(rw, r) }',
      'ServeHTTP',
    )).toEqual({ params: 2, hasResult: false, variadic: false });
  });

  it('strips a trailing "//" comment before deciding there is no result', () => {
    expect(sigShape('Reset() // resets internal state', 'Reset'))
      .toEqual({ params: 0, hasResult: false, variadic: false });
  });

  // The comment must be stripped before the brace is cut, not after.
  // Cutting the brace first would leave "// uses ", which is not empty
  // and would wrongly read as a result.
  it('strips the comment first, even when the comment mentions a brace', () => {
    expect(sigShape('Reset() // uses {}', 'Reset'))
      .toEqual({ params: 0, hasResult: false, variadic: false });
  });

  // A real result type can itself contain a brace. Cutting at the first
  // "{" must not eat into these — there is text left before the brace.
  it('still reads a struct result type that contains a brace', () => {
    expect(sigShape('func f() struct{ A int } {', 'f'))
      .toEqual({ params: 0, hasResult: true, variadic: false });
    expect(sigShape('func f() map[string]struct{} {', 'f'))
      .toEqual({ params: 0, hasResult: true, variadic: false });
  });

  // A one-line Go interface leaves its own closing "}" right after the last
  // method's parameter list. That "}" is not a result — it belongs to the
  // interface, not to Close — so this must read the same as the multi-line
  // form does.
  it('does not read a one-line interface\'s own closing brace as a result', () => {
    expect(sigShape('type Closer interface { Close() }', 'Close'))
      .toEqual({ params: 0, hasResult: false, variadic: false });
  });

  // Same idea, but the next member's leading ";" is what survives into
  // `rest` when two methods share one line.
  it('does not read the next member\'s ";" as a result', () => {
    expect(sigShape('type X interface { A(); B() }', 'A'))
      .toEqual({ params: 0, hasResult: false, variadic: false });
  });

  // A rest parameter means "any number more", not "at most this many" — the
  // caller (shapeSatisfies in local-sqlite.mjs) needs this bit to know when a
  // parameter-count ceiling does not apply at all. Real shape, from nest:
  // `LoggerService.error(message: any, ...optionalParams: any[]): any;`.
  it('marks a TypeScript rest parameter as variadic', () => {
    expect(sigShape('error(message: any, ...optionalParams: any[]): any;', 'error'))
      .toEqual({ params: 2, hasResult: true, variadic: true });
  });

  // Go spells the same idea `...any` with no leading dots-then-name. Both the
  // interface member and an implementing method must write it out, so the two
  // sides already compare correctly under plain equality — this only proves
  // the new `variadic` field does not disturb that.
  it('marks a Go variadic parameter as variadic, and still counts it as one parameter', () => {
    expect(sigShape('Printf(format string, args ...any)', 'Printf'))
      .toEqual({ params: 2, hasResult: false, variadic: true });
    expect(sigShape('func (l *Logger) Printf(format string, args ...any) {', 'Printf'))
      .toEqual({ params: 2, hasResult: false, variadic: true });
  });
});
