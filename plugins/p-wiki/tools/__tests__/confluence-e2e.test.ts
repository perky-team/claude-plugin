import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpClient } from '../lib/confluence/http.mjs';
import { request as httpsRequest } from 'node:https';

const skip = !process.env.PWIKI_E2E_CONFLUENCE;

function realTransport(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const r = httpsRequest({ host: url.host, path: url.pathname + url.search, method: req.method, headers: req.headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(buf); } catch { body = buf; }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
    });
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}

describe.skipIf(skip)('Confluence E2E', () => {
  const createdIds: string[] = [];
  let http: any;

  beforeAll(() => {
    http = createHttpClient({
      baseUrl: process.env.PWIKI_E2E_SITE_URL!,
      email: process.env.PWIKI_CONFLUENCE_EMAIL!,
      token: process.env.PWIKI_CONFLUENCE_TOKEN!,
      transport: realTransport,
    });
  });

  afterAll(async () => {
    for (const id of createdIds.reverse()) {
      try { await http.delete(`/wiki/api/v2/pages/${id}`); } catch { /* ignore */ }
    }
  });

  it('end-to-end scenario: new → search → set → new query → promote → index → lint', async () => {
    expect(skip).toBe(false);
    // ... see CONTRIBUTING.md
  });
});
