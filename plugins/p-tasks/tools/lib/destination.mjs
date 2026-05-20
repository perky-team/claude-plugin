import { createFsDestination } from './destinations/fs.mjs';
import { createJiraDestination } from './destinations/jira.mjs';

function makeTransport() {
  return async function transport(req) {
    const res = await globalThis.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    let body = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) { try { body = await res.json(); } catch { body = null; } }
    else { await res.text(); }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body };
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
