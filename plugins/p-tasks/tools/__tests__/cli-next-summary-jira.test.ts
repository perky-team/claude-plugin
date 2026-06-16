import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWithArgs, nextCommand, summaryCommand } from '../ptasks.mjs';

// End-to-end coverage for `next` / `summary` reading from the Jira destination:
// Jira listItems (via /search/jql + toItem) → pickNext / summarize. Verifies the
// blocked-task skip and the done-only summary filter operate on real Jira-shaped
// data (status + blockedBy derived from Blocks issue links), deterministically
// and without touching a live project.

let dir: string;
let exitSpy: any;
let stdoutSpy: any;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-next-jira-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
  const okProject = async () => ({ status: 200, headers: {}, body: { key: 'PROJ' } });
  try { await initWithArgs({ root: dir, args: { primary: 'jira', site: 'https://x.atlassian.net', project: 'PROJ', json: true }, transport: okProject }); } catch { /* exit:0 */ }
  stdoutSpy.mockClear();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

// A Jira issue as returned by /search/jql. `blockers` become inbound Blocks
// links (outwardIssue = the blocker), which toItem maps to blockedBy.
function issue(key: string, statusName: string, blockers: string[] = []) {
  return {
    id: key,
    key,
    fields: {
      summary: `Task ${key}`,
      description: null,
      status: { name: statusName },
      issuetype: { name: 'Task' },
      issuelinks: blockers.map(b => ({ type: { name: 'Blocks' }, outwardIssue: { key: b } })),
    },
  };
}

function jiraWith(issues: any[]) {
  return async (req: any) => {
    if (req.method === 'GET' && /\/rest\/api\/3\/project\//.test(req.url)) return { status: 200, headers: {}, body: { key: 'PROJ' } };
    if (req.method === 'POST' && req.url.includes('/rest/api/3/search/jql')) return { status: 200, headers: {}, body: { issues, isLast: true } };
    return { status: 404, headers: {}, body: { errorMessages: [`unhandled ${req.method} ${req.url}`] } };
  };
}

// emitJson() ends by calling process.exit, which the mock turns into a throw;
// the JSON was already written as the first stdout call, so read that.
function out() { return JSON.parse(stdoutSpy.mock.calls[0][0]); }

describe('next / summary against Jira', () => {
  it('next skips a task blocked by a not-done Jira issue', async () => {
    // PROJ-2 is blocked by PROJ-1 (still To Do); PROJ-3 is done.
    const transport = jiraWith([
      issue('PROJ-1', 'To Do'),
      issue('PROJ-2', 'To Do', ['PROJ-1']),
      issue('PROJ-3', 'Done'),
    ]);
    try { await nextCommand({ root: dir, args: { _: [], json: true }, transport }); }
    catch { /* emitJson exits via the mocked process.exit */ }
    expect(out().next.id).toBe('PROJ-1');
  });

  it('--all excludes the blocked and the done issues', async () => {
    const transport = jiraWith([
      issue('PROJ-1', 'To Do'),
      issue('PROJ-2', 'To Do', ['PROJ-1']),
      issue('PROJ-3', 'Done'),
    ]);
    try { await nextCommand({ root: dir, args: { _: [], all: true, json: true }, transport }); }
    catch { /* emitJson exits via the mocked process.exit */ }
    expect(out().items.map((i: any) => i.id)).toEqual(['PROJ-1']);
  });

  it('next returns the task once its Jira blocker is done', async () => {
    const transport = jiraWith([
      issue('PROJ-1', 'Done'),
      issue('PROJ-2', 'To Do', ['PROJ-1']),
    ]);
    try { await nextCommand({ root: dir, args: { _: [], json: true }, transport }); }
    catch { /* emitJson exits via the mocked process.exit */ }
    expect(out().next.id).toBe('PROJ-2');
  });

  it('summary lists the done tasks from Jira', async () => {
    const transport = jiraWith([
      issue('PROJ-1', 'Done'),
      issue('PROJ-2', 'To Do'),
      issue('PROJ-3', 'Done'),
    ]);
    try { await summaryCommand({ root: dir, args: { _: [], json: true }, transport }); }
    catch { /* emitJson exits via the mocked process.exit */ }
    expect(out().items.map((i: any) => i.id)).toEqual(['PROJ-1', 'PROJ-3']);
  });
});
