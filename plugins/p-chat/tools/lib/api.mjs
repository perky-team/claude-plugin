export class ApiError extends Error {
  constructor(message, { status, description } = {}) {
    super(message);
    this.status = status;
    this.description = description;
  }
}

// Minimal Bot API client: plain fetch + JSON, zero deps. Each call resolves to the
// parsed `result` or throws ApiError (network, timeout, non-2xx, ok:false). apiBase
// is configurable — the test seam for the in-test mock server. The token rides in
// the URL path per Bot API convention; it is never logged.
export function makeApi({ apiBase, token, timeoutSec = 10, fetchFn = fetch }) {
  const call = async (method, payload) => {
    const url = `${String(apiBase).replace(/\/+$/, '')}/bot${token}/${method}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutSec * 1000);
    let res, body;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: ctl.signal,
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      throw new ApiError(`telegram ${method} failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (!body || body.ok !== true) {
      throw new ApiError(`telegram ${method} error: ${body?.description ?? `HTTP ${res.status}`}`, { status: res.status, description: body?.description });
    }
    return body.result;
  };
  return {
    getMe: () => call('getMe'),
    // timeout: 0 -> a PEEK, not a long poll: Telegram re-serves updates until a later
    // offset confirms them (and holds them ~24h).
    getUpdates: (offset) => call('getUpdates', { ...(offset != null ? { offset } : {}), timeout: 0 }),
    sendMessage: (payload) => call('sendMessage', payload),
  };
}
