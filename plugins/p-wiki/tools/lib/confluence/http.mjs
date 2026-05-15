const RETRIABLE = new Set([429, 502, 503, 504]);
const NON_RETRY_POST = new Set(['/wiki/api/v2/pages']); // exact match
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetriable(method, path, status) {
  if (!RETRIABLE.has(status)) return false;
  if (method === 'POST' && NON_RETRY_POST.has(path)) return false;
  return true; // GET/PUT/DELETE always retriable on these codes; idempotent POSTs too
}

export function createHttpClient({ baseUrl, email, token, transport, baseDelayMs = 1000, maxRetries = MAX_RETRIES }) {
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  async function call(method, path, body) {
    const url = baseUrl.replace(/\/+$/, '') + path;
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = { method, url, path, headers, body: body === undefined ? undefined : JSON.stringify(body) };

    let attempt = 0;
    while (true) {
      const res = await transport(req);
      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, headers: res.headers ?? {}, body: res.body ?? null };
      }
      if (attempt < maxRetries && isRetriable(method, path, res.status)) {
        const retryAfter = Number(res.headers?.['retry-after']);
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        attempt++;
        continue;
      }
      const err = new Error(`HTTP ${res.status} ${method} ${path}`);
      err.status = res.status;
      err.body = res.body;
      throw err;
    }
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    delete: (p) => call('DELETE', p),
  };
}
