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
});
