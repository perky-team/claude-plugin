import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, validateConfig, defaultConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-config-'));
  mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const jiraBlock = {
  kind: 'jira',
  siteUrl: 'https://x.atlassian.net',
  projectKey: 'PROJ',
  issueTypes: { task: 'Task', subTask: 'Sub-task' },
  statusMap: { todo: 'To Do', in_progress: 'In Progress', done: 'Done' },
  jql: 'project = PROJ AND issuetype in (Task, Sub-task)',
};

describe('config', () => {
  it('returns defaultConfig when .ptasks.json is absent', () => {
    expect(readConfig(dir)).toEqual(defaultConfig());
  });
  it('defaultConfig is fs-only', () => {
    expect(defaultConfig()).toEqual({ primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } });
  });
  it('round-trips a config with primary=fs and one jira mirror', () => {
    const cfg = { primary: 'fs', mirrors: ['jira'], destinations: { fs: { kind: 'fs' }, jira: jiraBlock } };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });
  it('validateConfig rejects missing primary', () => {
    expect(validateConfig({}).ok).toBe(false);
  });
  it('validateConfig rejects mirror that does not key into destinations', () => {
    expect(validateConfig({ primary: 'fs', mirrors: ['nope'], destinations: { fs: { kind: 'fs' } } }).ok).toBe(false);
  });
  it('validateConfig rejects jira block missing required fields', () => {
    expect(validateConfig({ primary: 'jira', mirrors: [], destinations: { jira: { kind: 'jira' } } }).ok).toBe(false);
  });
  it('validateConfig rejects an fs mirror of a jira primary (no id correlation)', () => {
    const cfg = { primary: 'jira', mirrors: ['fs'], destinations: { jira: jiraBlock, fs: { kind: 'fs' } } };
    const v = validateConfig(cfg);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/fs mirror/);
  });
  it('validateConfig allows a jira mirror of an fs primary', () => {
    const cfg = { primary: 'fs', mirrors: ['jira'], destinations: { fs: { kind: 'fs' }, jira: jiraBlock } };
    expect(validateConfig(cfg).ok).toBe(true);
  });
});
