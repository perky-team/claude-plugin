import { describe, expect, it } from 'vitest';
import { createIssue, updateIssueFields, transitionIssue, listIssues } from '../lib/jira/issues.mjs';

function recordingTransport(responses: any[]) {
  const calls: any[] = [];
  let i = 0;
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...responses[i++] }; } };
}

const httpFor = (transport: any) => ({
  get: async (p: string) => transport({ method: 'GET', url: 'https://x' + p, headers: {} }),
  post: async (p: string, body: any) => transport({ method: 'POST', url: 'https://x' + p, headers: {}, body: JSON.stringify(body) }),
  put: async (p: string, body: any) => transport({ method: 'PUT', url: 'https://x' + p, headers: {}, body: JSON.stringify(body) }),
  delete: async (p: string) => transport({ method: 'DELETE', url: 'https://x' + p, headers: {} }),
});

describe('jira/issues', () => {
  it('createIssue posts the right body and returns key', async () => {
    const r = recordingTransport([{ status: 201, body: { id: '1', key: 'PROJ-1' } }]);
    const http = httpFor(r.transport);
    const out = await createIssue(http, { projectKey: 'PROJ', issueType: 'Task', summary: 'T', description: 'D' });
    expect(out).toEqual({ id: '1', key: 'PROJ-1' });
    expect(r.calls[0].url).toContain('/rest/api/3/issue');
    const body = JSON.parse(r.calls[0].body);
    expect(body.fields.project.key).toBe('PROJ');
    expect(body.fields.summary).toBe('T');
    expect(body.fields.issuetype.name).toBe('Task');
  });
  it('createIssue with parentKey sets parent for sub-task', async () => {
    const r = recordingTransport([{ status: 201, body: { id: '2', key: 'PROJ-2' } }]);
    const http = httpFor(r.transport);
    await createIssue(http, { projectKey: 'PROJ', issueType: 'Sub-task', summary: 'S', parentKey: 'PROJ-1' });
    expect(JSON.parse(r.calls[0].body).fields.parent.key).toBe('PROJ-1');
  });
  it('transitionIssue picks transition by target name', async () => {
    const r = recordingTransport([
      { status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }, { id: '21', to: { name: 'Done' } }] } },
      { status: 204, body: null },
    ]);
    const http = httpFor(r.transport);
    await transitionIssue(http, 'PROJ-1', 'Done');
    expect(JSON.parse(r.calls[1].body).transition.id).toBe('21');
  });
  it('transitionIssue throws transition-not-found if no match', async () => {
    const r = recordingTransport([{ status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }] } }]);
    const http = httpFor(r.transport);
    await expect(transitionIssue(http, 'PROJ-1', 'Done')).rejects.toMatchObject({ code: 'transition-not-found' });
  });
});
