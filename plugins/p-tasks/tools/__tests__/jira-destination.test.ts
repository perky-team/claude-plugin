import { describe, expect, it } from 'vitest';
import { createJiraDestination } from '../lib/destinations/jira.mjs';

function fakeJira(responses: Array<{ status: number; body?: any }>) {
  let i = 0;
  const calls: any[] = [];
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...responses[i++] }; } };
}

describe('jira destination', () => {
  it('ensureStructure validates the project exists', async () => {
    const fake = fakeJira([{ status: 200, body: { key: 'PROJ' } }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: '' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    await dst.ensureStructure();
    expect(fake.calls[0].url).toContain('/rest/api/3/project/PROJ');
  });
  it('listItems flattens Jira issues with parent meta on sub-tasks', async () => {
    const fake = fakeJira([{
      status: 200, body: {
        total: 2, issues: [
          { id: '1', key: 'PROJ-1', fields: { summary: 'T', description: { content: [{ content: [{ text: 'D' }] }] }, status: { name: 'To Do' }, issuetype: { name: 'Task' }, issuelinks: [] } },
          { id: '2', key: 'PROJ-2', fields: { summary: 'S', description: null, status: { name: 'Done' }, issuetype: { name: 'Sub-task' }, parent: { key: 'PROJ-1' }, issuelinks: [] } },
        ],
      },
    }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: 'project = PROJ' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const items = await dst.listItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'PROJ-1', type: 'task', title: 'T', status: 'todo' });
    expect(items[1]).toMatchObject({ id: 'PROJ-2', type: 'sub-task', parentId: 'PROJ-1', status: 'done' });
  });
  it('createItem returns the new Jira key as id', async () => {
    const fake = fakeJira([{ status: 201, body: { id: '99', key: 'PROJ-9' } }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: '' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const out = await dst.createItem({ type: 'task', title: 'New', description: '', status: 'todo', blockedBy: [] });
    expect(out.id).toBe('PROJ-9');
    expect(out.title).toBe('New');
  });
});
