import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWithArgs, setCommand, addCommand } from '../ptasks.mjs';

// Regression guard for read-your-writes against Jira. Jira's JQL search index is
// eventually consistent — an issue created moments ago may be missing from a
// `search/jql` result even though it is directly readable by key. The CLI must
// resolve the target (and validate blockers) by key, NOT via listItems/JQL.

let dir: string;
let exitSpy: any;
let stdoutSpy: any;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-set-jira-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
  const okProject = async () => ({ status: 200, headers: {}, body: { key: 'PROJ' } });
  try { await initWithArgs({ root: dir, args: { primary: 'jira', site: 'https://x.atlassian.net', project: 'PROJ', json: true }, transport: okProject }); } catch { /* exit:0 */ }
  stdoutSpy.mockClear();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

// JQL search always returns empty (worst-case index lag); issues are readable by key.
function laggyJira(issuesByKey: Record<string, any>) {
  return async (req: any) => {
    const { method, url } = req;
    if (method === 'GET' && /\/rest\/api\/3\/project\//.test(url)) return { status: 200, headers: {}, body: { key: 'PROJ' } };
    if (method === 'POST' && url.includes('/rest/api/3/search/jql')) return { status: 200, headers: {}, body: { issues: [], isLast: true } };
    if (url.includes('/rest/api/3/issueLink')) return { status: method === 'POST' ? 201 : 204, headers: {}, body: null };
    let m = /\/rest\/api\/3\/issue\/([^/?]+)\/transitions/.exec(url);
    if (m) {
      if (method === 'GET') return { status: 200, headers: {}, body: { transitions: [{ id: '21', to: { name: 'In Progress' } }] } };
      if (method === 'POST') return { status: 204, headers: {}, body: null };
    }
    m = /\/rest\/api\/3\/issue\/([^/?]+)/.exec(url);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const fields = issuesByKey[key];
      if (!fields) return { status: 404, headers: {}, body: { errorMessages: ['not found'] } };
      if (method === 'GET') return { status: 200, headers: {}, body: { fields } };
      if (method === 'PUT') return { status: 204, headers: {}, body: null };
    }
    return { status: 404, headers: {}, body: { errorMessages: [`unhandled ${method} ${url}`] } };
  };
}

const freshTask = { summary: 'Fresh', description: null, status: { name: 'To Do' }, issuetype: { name: 'Task' }, issuelinks: [] };

describe('setCommand against Jira (read-your-writes)', () => {
  it('updates status of a key the JQL search has not indexed yet', async () => {
    const transport = laggyJira({ 'PROJ-123': freshTask });
    try { await setCommand({ root: dir, args: { _: ['PROJ-123'], status: 'in_progress', json: true }, transport }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.id).toBe('PROJ-123');
    expect(out.status).toBe('in_progress');
  });

  it('still reports item-not-found when the key truly does not exist', async () => {
    const transport = laggyJira({});
    try { await setCommand({ root: dir, args: { _: ['PROJ-999'], status: 'done', json: true }, transport }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('item-not-found');
  });

  it('validates a blocker by key when the search list lags', async () => {
    // Both the target and its blocker are readable by key but absent from search.
    const transport = laggyJira({ 'PROJ-1': freshTask, 'PROJ-2': freshTask });
    try { await setCommand({ root: dir, args: { _: ['PROJ-1'], 'add-blocker': 'PROJ-2', json: true }, transport }); }
    catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.blockedBy).toEqual(['PROJ-2']);
  });
});
