import { describe, expect, it } from 'vitest';
import { loadTasksDoc, dumpTasksDoc } from '../lib/yaml.mjs';

const sample = {
  tasks: [
    {
      id: 't-1',
      title: 'Login',
      description: 'OAuth',
      status: 'in_progress',
      blockedBy: [],
      subTasks: [
        { id: 'st-1', title: 'Bcrypt', description: '', status: 'todo', blockedBy: ['st-2'] },
        { id: 'st-2', title: 'Schema', description: '', status: 'done', blockedBy: [] },
      ],
    },
    {
      id: 't-2',
      title: 'CI',
      description: '',
      status: 'todo',
      blockedBy: ['t-1'],
      subTasks: [],
    },
  ],
};

describe('yaml round-trip', () => {
  it('round-trips a non-trivial document', () => {
    const text = dumpTasksDoc(sample);
    expect(loadTasksDoc(text)).toEqual(sample);
  });
  it('loads an empty document', () => {
    expect(loadTasksDoc('tasks: []\n')).toEqual({ tasks: [] });
  });
  it('rejects a doc without a top-level tasks: array', () => {
    expect(() => loadTasksDoc('something: else\n')).toThrow(/tasks/);
  });
  it('preserves unknown top-level keys through a read→write cycle', () => {
    const text = dumpTasksDoc({ version: 2, note: 'hand-written', tasks: [] });
    const reloaded: any = loadTasksDoc(text);
    expect(reloaded.version).toBe(2);
    expect(reloaded.note).toBe('hand-written');
  });
  it('preserves key order: id, title, description, status, blockedBy, jiraKeys, subTasks', () => {
    const out = dumpTasksDoc({
      tasks: [{ id: 't-1', title: 'T', description: 'D', status: 'todo', blockedBy: [], jiraKeys: { 'jira-prod': 'PROJ-9' }, subTasks: [] }],
    });
    const order = ['id:', 'title:', 'description:', 'status:', 'blockedBy:', 'jiraKeys:', 'subTasks:'];
    let pos = -1;
    for (const k of order) {
      const i = out.indexOf(k);
      expect(i, `expected ${k} to appear in order`).toBeGreaterThan(pos);
      pos = i;
    }
  });
});
