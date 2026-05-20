import { describe, expect, it } from 'vitest';
import { createJiraDestination } from '../lib/destinations/jira.mjs';

function fakeJira(seq: any[]) {
  let i = 0;
  const calls: any[] = [];
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...seq[i++] }; } };
}

const block = { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' }, jql: '' };

describe('jira destination — updateItem', () => {
  it('updates summary/description via PUT', async () => {
    const fake = fakeJira([{ status: 204 }]);
    const dst = createJiraDestination({ block, email: 'a@b.c', token: 't', transport: fake.transport });
    await dst.updateItem('PROJ-1', { title: 'X', description: 'Y' });
    expect(fake.calls[0].method).toBe('PUT');
    const body = JSON.parse(fake.calls[0].body);
    expect(body.fields.summary).toBe('X');
  });
  it('reconciles blockers — DELETEs extras and POSTs missing', async () => {
    const fake = fakeJira([
      // GET existing links: PROJ-1 inwardly linked from PROJ-99 (existing) and PROJ-100 (extra)
      { status: 200, body: { fields: { issuelinks: [
        { id: '500', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-99' } },
        { id: '501', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-100' } },
      ] } } },
      { status: 204 },                                                       // DELETE 501
      { status: 201 },                                                       // POST new link to PROJ-50
    ]);
    const dst = createJiraDestination({ block, email: 'a@b.c', token: 't', transport: fake.transport });
    await dst.updateItem('PROJ-1', { blockedBy: ['PROJ-99', 'PROJ-50'] });
    const methods = fake.calls.map((c: any) => c.method);
    expect(methods).toEqual(['GET', 'DELETE', 'POST']);
    expect(fake.calls[1].url).toContain('/issueLink/501');
    const linkBody = JSON.parse(fake.calls[2].body);
    expect(linkBody.outwardIssue.key).toBe('PROJ-50');
  });
  it('status transition propagates transition-not-found as hard error', async () => {
    const fake = fakeJira([
      { status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }] } },
    ]);
    const dst = createJiraDestination({ block, email: 'a@b.c', token: 't', transport: fake.transport });
    await expect(dst.updateItem('PROJ-1', { status: 'done' })).rejects.toMatchObject({ code: 'transition-not-found' });
  });
});
