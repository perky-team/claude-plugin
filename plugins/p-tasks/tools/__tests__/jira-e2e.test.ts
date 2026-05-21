// Real Jira end-to-end. Opt-in via PTASKS_E2E_JIRA=1 + credentials.
// Skipped in default `npm test` runs — mirrors p-wiki's confluence-e2e pattern.
//
// To run locally against a real Jira project:
//   PTASKS_E2E_JIRA=1 \
//   PTASKS_JIRA_EMAIL=you@example.com \
//   PTASKS_JIRA_TOKEN=... \
//   PTASKS_E2E_SITE_URL=https://your.atlassian.net \
//   PTASKS_E2E_PROJECT_KEY=YOURPROJ \
//   npx vitest run plugins/p-tasks/tools/__tests__/jira-e2e.test.ts
//
// The test creates real issues. They are NOT auto-deleted (Jira doesn't reuse keys);
// inspect / archive them by hand after the run.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpsRequest } from 'node:https';
import { createJiraDestination } from '../lib/destinations/jira.mjs';

const skip = !process.env.PTASKS_E2E_JIRA;

function realTransport(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const r = httpsRequest(
      { host: url.host, path: url.pathname + url.search, method: req.method, headers: req.headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let body: any = null;
          try { body = JSON.parse(buf); } catch { body = buf; }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers ?? {})) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
          }
          resolve({ status: res.statusCode ?? 0, headers, body });
        });
      },
    );
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}

describe.skipIf(skip)('Jira E2E', () => {
  const createdKeys: string[] = [];
  let dest: any;

  beforeAll(() => {
    const projectKey = process.env.PTASKS_E2E_PROJECT_KEY!;
    const siteUrl = process.env.PTASKS_E2E_SITE_URL!;
    const block = {
      kind: 'jira',
      siteUrl,
      projectKey,
      issueTypes: { task: 'Task', subTask: 'Sub-task' },
      statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' },
      jql: `project = ${projectKey} AND issuetype in ("Task", "Sub-task")`,
    };
    dest = createJiraDestination({
      block,
      email: process.env.PTASKS_JIRA_EMAIL!,
      token: process.env.PTASKS_JIRA_TOKEN!,
      transport: realTransport,
    });
  }, 30_000);

  afterAll(() => {
    if (createdKeys.length > 0) {
      // We don't auto-delete — Jira keys are append-only and deletion requires
      // permissions the API token may not have. Print so the runner can clean up.
      // eslint-disable-next-line no-console
      console.log(`[jira-e2e] created keys (clean up manually): ${createdKeys.join(', ')}`);
    }
  });

  it('ensureStructure passes against a real project', async () => {
    await expect(dest.ensureStructure()).resolves.toBeUndefined();
  }, 30_000);

  it('createItem produces a real Task issue and returns its key', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const created = await dest.createItem({
      type: 'task',
      title: `[ptasks-e2e ${stamp}] parent`,
      description: 'created by p-tasks jira-e2e test',
      status: 'todo',
      blockedBy: [],
    });
    expect(created.id).toMatch(/^[A-Z][A-Z0-9_]*-\d+$/);
    createdKeys.push(created.id);
  }, 30_000);

  it('createItem with parentKey produces a real Sub-task linked to the parent', async () => {
    const parentKey = createdKeys[createdKeys.length - 1];
    expect(parentKey, 'parent must exist from previous test').toBeDefined();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const created = await dest.createItem({
      type: 'sub-task',
      parentId: parentKey,
      title: `[ptasks-e2e ${stamp}] child`,
      description: '',
      status: 'todo',
      blockedBy: [],
    });
    expect(created.id).toMatch(/^[A-Z][A-Z0-9_]*-\d+$/);
    createdKeys.push(created.id);

    // Read back and check parent
    const refetched = await dest.readItem(created.id);
    expect(refetched.parentId).toBe(parentKey);
    expect(refetched.type).toBe('sub-task');
  }, 30_000);

  it('updateItem transitions status via Jira workflow', async () => {
    const key = createdKeys[0];
    await dest.updateItem(key, { status: 'in_progress' });
    const refetched = await dest.readItem(key);
    expect(refetched.status).toBe('in_progress');
  }, 30_000);

  it('updateItem reconciles blocker links — adds then removes', async () => {
    const sourceKey = createdKeys[0];
    const blockerKey = createdKeys[1];
    if (!sourceKey || !blockerKey) throw new Error('need at least two created items');

    await dest.updateItem(sourceKey, { blockedBy: [blockerKey] });
    let refetched = await dest.readItem(sourceKey);
    expect(refetched.blockedBy).toContain(blockerKey);

    await dest.updateItem(sourceKey, { blockedBy: [] });
    refetched = await dest.readItem(sourceKey);
    expect(refetched.blockedBy).not.toContain(blockerKey);
  }, 30_000);

  it('listItems returns the issues we just created', async () => {
    const items = await dest.listItems();
    const ids = items.map((i: any) => i.id);
    for (const k of createdKeys) {
      expect(ids).toContain(k);
    }
  }, 60_000);
});
