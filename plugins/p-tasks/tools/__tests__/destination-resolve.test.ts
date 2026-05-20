import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDestination } from '../lib/destination.mjs';
import { defaultConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ptasks-resolve-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveDestination', () => {
  it('returns FS primary on default config', () => {
    const res = resolveDestination({ root: dir, config: defaultConfig() });
    expect(res.primary.kind).toBe('fs');
    expect(res.primaryName).toBe('fs');
    expect(res.mirrors).toEqual([]);
    expect(res.mirrorNames).toEqual([]);
  });
  it('reports primaryName matching config', () => {
    const cfg = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
    const res = resolveDestination({ root: dir, config: cfg });
    expect(res.primaryName).toBe('fs');
  });
  it('lazily instantiates mirrors (mirrorNames populated, mirrors getter on demand)', () => {
    const cfg = {
      primary: 'fs',
      mirrors: ['fs2'],
      destinations: { fs: { kind: 'fs' }, fs2: { kind: 'fs' } },
    };
    const res = resolveDestination({ root: dir, config: cfg });
    expect(res.mirrorNames).toEqual(['fs2']);
    expect(res.mirrors).toHaveLength(1);
    expect(res.mirrors[0].name).toBe('fs2');
  });
  it('builds a jira destination from a jira block', () => {
    process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
    process.env.PTASKS_JIRA_TOKEN = 't';
    const cfg = {
      primary: 'fs',
      mirrors: ['j'],
      destinations: {
        fs: { kind: 'fs' },
        j: { kind: 'jira', siteUrl: 'https://x', projectKey: 'PROJ', issueTypes: { task: 'Task', subTask: 'Sub-task' }, statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' }, jql: '' },
      },
    };
    const res = resolveDestination({ root: dir, config: cfg });
    expect(res.mirrors[0].kind).toBe('jira');
  });
});
