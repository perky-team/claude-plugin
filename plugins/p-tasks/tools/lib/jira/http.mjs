export function mapErrorToCode(err) {
  const s = err?.status;
  if (s === 401 || s === 403) return 'auth-failed';
  if (s === 404) return 'item-not-found';
  if (s === 409) return 'version-conflict';
  if (s === 429) return 'rate-limited';
  if (typeof s === 'number' && s >= 500) return 'network-error';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err?.code)) return 'network-error';
  return 'internal';
}

export function createHttpClient({ baseUrl, email, token, transport, retryDelays = [200, 800, 2400] }) {
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  async function call(method, path, body) {
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = { method, url: baseUrl + path, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    for (let attempt = 0; ; attempt++) {
      const res = await transport(req);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retryDelays.length) {
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
          continue;
        }
      }
      return res;
    }
  }
  return {
    get: (p) => call('GET', p),
    post: (p, body) => call('POST', p, body),
    put: (p, body) => call('PUT', p, body),
    delete: (p) => call('DELETE', p),
  };
}
