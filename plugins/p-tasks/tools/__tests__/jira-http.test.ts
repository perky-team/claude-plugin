import { describe, expect, it } from 'vitest';
import { createHttpClient, mapErrorToCode } from '../lib/jira/http.mjs';

function fakeTransport(responses: Array<{ status: number; body?: any }>) {
  let i = 0;
  return {
    transport: async () => {
      if (i >= responses.length) throw new Error('unexpected extra request');
      return { headers: {}, ...responses[i++] };
    },
    callCount: () => i,
  };
}

describe('jira/http', () => {
  it('GET returns body on 200', async () => {
    const { transport } = fakeTransport([{ status: 200, body: { hi: 1 } }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a@b.c', token: 't', transport });
    expect(await c.get('/rest/api/3/myself')).toEqual({ status: 200, headers: {}, body: { hi: 1 } });
  });
  it('retries on 429 then succeeds', async () => {
    const { transport, callCount } = fakeTransport([{ status: 429, body: null }, { status: 200, body: { ok: true } }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a@b.c', token: 't', transport, retryDelays: [0, 0] });
    expect((await c.get('/x')).status).toBe(200);
    expect(callCount()).toBe(2);
  });
  it('mapErrorToCode maps known statuses', () => {
    expect(mapErrorToCode({ status: 401 })).toBe('auth-failed');
    expect(mapErrorToCode({ status: 403 })).toBe('auth-failed');
    expect(mapErrorToCode({ status: 404 })).toBe('item-not-found');
    expect(mapErrorToCode({ status: 409 })).toBe('version-conflict');
    expect(mapErrorToCode({ status: 429 })).toBe('rate-limited');
    expect(mapErrorToCode({ status: 503 })).toBe('network-error');
    expect(mapErrorToCode({ code: 'ECONNREFUSED' })).toBe('network-error');
    expect(mapErrorToCode({})).toBe('internal');
  });
});
