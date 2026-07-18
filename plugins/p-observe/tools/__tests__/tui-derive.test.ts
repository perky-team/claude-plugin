import { describe, expect, it } from 'vitest';
import { jobsList, tasksList, pagesList, graphHistory, eventsFor } from '../lib/tui/derive.mjs';

const ev = (o) => ({ ts: 1, plugin: '-', kind: '-', entity: '-', severity: 'info', summary: '', data: {}, ...o });

describe('jobsList', () => {
  it('merges log events with status, sorts failed/running first', () => {
    const events = [
      ev({ plugin: 'p-shed', kind: 'job.finished', entity: 'lint', severity: 'error', summary: 'exit 1' }),
      ev({ plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0' }),
    ];
    const status = { pshed: { running: ['build'], jobs: { lint: { lastExit: 1 }, daily: { lastExit: 0 } } } };
    const list = jobsList(events, status);
    expect(list.map((j) => j.id)).toEqual(['lint', 'build', 'daily']); // failed, running, ok
    expect(list.find((j) => j.id === 'build').running).toBe(true);
  });
});

describe('tasksList', () => {
  it('tracks latest status and history from task events', () => {
    const events = [
      ev({ plugin: 'p-tasks', kind: 'task.added', entity: 'T1', summary: 'added (todo)' }),
      ev({ plugin: 'p-tasks', kind: 'task.status', entity: 'T1', summary: 'todo → done', data: { to: 'done' } }),
    ];
    const list = tasksList(events);
    expect(list[0].id).toBe('T1');
    expect(list[0].status).toBe('done');
    expect(list[0].history).toHaveLength(2);
  });
});

describe('pagesList / graphHistory / eventsFor', () => {
  it('collects wiki pages, graph history, and filters by plugin', () => {
    const events = [
      ev({ plugin: 'p-wiki', kind: 'page.compiled', entity: 'a.md', summary: 'compiled' }),
      ev({ plugin: 'p-wiki', kind: 'wiki.conflict', entity: 'a.md', summary: 'conflict flagged' }),
      ev({ plugin: 'p-graph', kind: 'index.refresh', entity: '-', summary: '+3 nodes' }),
    ];
    expect(pagesList(events)[0]).toMatchObject({ id: 'a.md', conflict: true });
    expect(graphHistory(events)).toHaveLength(1);
    expect(eventsFor(events, 'p-wiki')).toHaveLength(2);
  });
});
