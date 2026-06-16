import { createFsDestination } from './destinations/fs.mjs';
import { createJiraDestination } from './destinations/jira.mjs';

export function makeTransport() {
  // Use node:https (not global fetch/undici). The CLI calls process.exit()
  // immediately after a request resolves; undici's keep-alive socket pool is
  // still tearing down at that point, which trips a libuv assertion
  // (UV_HANDLE_CLOSING) and crashes the process with a non-zero code on Windows.
  // A per-request https agent with keepAlive:false closes the socket before exit.
  return async function transport(req) {
    const https = await import('node:https');
    const agent = new https.Agent({ keepAlive: false });
    return new Promise((resolve, reject) => {
      const request = https.request;
      const url = new URL(req.url);
      const r = request(
        { host: url.host, path: url.pathname + url.search, method: req.method, headers: req.headers, agent },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            let body = null;
            const ct = String(res.headers['content-type'] ?? '');
            if (ct.includes('application/json')) { try { body = JSON.parse(buf); } catch { body = null; } }
            const headers = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
            resolve({ status: res.statusCode ?? 0, headers, body });
          });
        },
      );
      r.on('error', reject);
      if (req.body !== undefined && req.body !== null) r.write(req.body);
      r.end();
    });
  };
}

function buildDestination({ root, name, block, transport }) {
  if (block.kind === 'fs') return createFsDestination({ root, name });
  if (block.kind === 'jira') {
    const email = process.env.PTASKS_JIRA_EMAIL;
    const token = process.env.PTASKS_JIRA_TOKEN;
    if (!email || !token) throw Object.assign(new Error('PTASKS_JIRA_EMAIL and PTASKS_JIRA_TOKEN required'), { code: 'auth-failed' });
    return createJiraDestination({ block, email, token, transport: transport ?? makeTransport(), name });
  }
  throw new Error(`unsupported destination kind: ${block.kind}`);
}

export function resolveDestination({ root, config, transport }) {
  const primaryName = config.primary;
  const primary = buildDestination({ root, name: primaryName, block: config.destinations[primaryName], transport });
  const mirrorNames = config.mirrors ?? [];
  const mirrors = mirrorNames.map(n => buildDestination({ root, name: n, block: config.destinations[n], transport }));
  return { primary, primaryName, mirrors, mirrorNames };
}
