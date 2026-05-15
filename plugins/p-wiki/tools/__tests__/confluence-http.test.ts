import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../lib/confluence/http.mjs';

function fakeTransport(responses: Array<{status: number, headers?: Record<string,string>, body?: any}>) {
  const calls: any[] = [];
  let i = 0;
  const fn = async (req: any) => {
    calls.push(req);
    return responses[Math.min(i++, responses.length - 1)];
  };
  (fn as any).calls = calls;
  return fn;
}

describe('confluence/http', () => {
  it('sends Basic auth and JSON content-type', async () => {
    const t = fakeTransport([{ status: 200, body: { ok: true } }]);
    const c = createHttpClient({ baseUrl: 'https://x.atlassian.net', email: 'a@b.c', token: 'tok', transport: t });
    await c.get('/wiki/api/v2/pages/1');
    const req = (t as any).calls[0];
    expect(req.headers.Authorization).toBe('Basic ' + Buffer.from('a@b.c:tok').toString('base64'));
    expect(req.headers.Accept).toBe('application/json');
  });

  it('retries GET on 429 with exponential backoff', async () => {
    const t = fakeTransport([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: { ok: 1 } },
    ]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    const r = await c.get('/x');
    expect(r.body).toEqual({ ok: 1 });
    expect((t as any).calls.length).toBe(3);
  });

  it('does not retry page-create POST on 5xx', async () => {
    const t = fakeTransport([{ status: 503 }, { status: 200 }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    await expect(c.post('/wiki/api/v2/pages', { x: 1 })).rejects.toThrow(/HTTP 503/);
    expect((t as any).calls.length).toBe(1);
  });

  it('retries idempotent POST (labels)', async () => {
    const t = fakeTransport([{ status: 503 }, { status: 200, body: {} }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    await c.post('/wiki/rest/api/content/1/label', [{ name: 'tag' }]);
    expect((t as any).calls.length).toBe(2);
  });

  it('throws after retry cap with status in error', async () => {
    const t = fakeTransport([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const c = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: t, baseDelayMs: 0 });
    await expect(c.get('/x')).rejects.toMatchObject({ status: 429 });
  });
});
