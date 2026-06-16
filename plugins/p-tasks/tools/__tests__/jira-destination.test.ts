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
  it('listItems reads blockedBy from inbound Blocks links (outwardIssue is the blocker)', async () => {
    const fake = fakeJira([{
      status: 200, body: {
        issues: [
          { id: '1', key: 'PROJ-1', fields: {
            summary: 'T', description: null, status: { name: 'To Do' }, issuetype: { name: 'Task' },
            issuelinks: [
              { id: '9', type: { name: 'Blocks' }, outwardIssue: { key: 'PROJ-2' } }, // PROJ-1 blocked by PROJ-2
              { id: '8', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-3' } },  // PROJ-1 blocks PROJ-3 — outbound
            ],
          } },
        ],
      },
    }]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: 'project = PROJ' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const items = await dst.listItems();
    expect(items[0].blockedBy).toEqual(['PROJ-2']);
  });
  it('createItem with an untransitionable status falls back to todo instead of aborting', async () => {
    const fake = fakeJira([
      { status: 201, body: { id: '7', key: 'PROJ-7' } },                                  // create
      { status: 200, body: { transitions: [{ id: '11', to: { name: 'In Progress' } }] } }, // no direct Done
    ]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: '' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const out = await dst.createItem({ type: 'task', title: 'New', description: '', status: 'done', blockedBy: [] });
    expect(out.id).toBe('PROJ-7');
    expect(out.status).toBe('todo');
  });
  it('createItem creates a Blocks link for each blocker (add --blocked-by persists immediately)', async () => {
    const fake = fakeJira([
      { status: 201, body: { id: '7', key: 'PROJ-7' } }, // create issue
      { status: 201, body: {} },                          // POST /issueLink
    ]);
    const dst = createJiraDestination({
      block: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo:'To Do',in_progress:'In Progress',done:'Done' }, jql: '' },
      email: 'a@b.c', token: 't',
      transport: fake.transport,
    });
    const out = await dst.createItem({ type: 'task', title: 'New', description: '', status: 'todo', blockedBy: ['PROJ-2'] });
    expect(out.blockedBy).toEqual(['PROJ-2']);
    const linkCall = fake.calls.find((c: any) => c.url.includes('/rest/api/3/issueLink'));
    expect(linkCall, 'a /issueLink POST should have been made').toBeDefined();
    const body = JSON.parse(linkCall.body);
    expect(body.type.name).toBe('Blocks');
    expect(body.inwardIssue.key).toBe('PROJ-7');  // the new issue is blocked…
    expect(body.outwardIssue.key).toBe('PROJ-2'); // …by PROJ-2
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
