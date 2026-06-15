import { describe, expect, it } from 'vitest';
import { createBlocksLink, deleteLink, listBlocksLinks } from '../lib/jira/links.mjs';

function recordingTransport(responses: any[]) {
  const calls: any[] = [];
  let i = 0;
  return { calls, transport: async (req: any) => { calls.push(req); return { headers: {}, ...responses[i++] }; } };
}
const httpFor = (t: any) => ({
  get: (p: string) => t({ method: 'GET', url: 'https://x' + p, headers: {} }),
  post: (p: string, body: any) => t({ method: 'POST', url: 'https://x' + p, headers: {}, body: JSON.stringify(body) }),
  delete: (p: string) => t({ method: 'DELETE', url: 'https://x' + p, headers: {} }),
});

describe('jira/links', () => {
  it('createBlocksLink posts the right body', async () => {
    const r = recordingTransport([{ status: 201, body: {} }]);
    const http = httpFor(r.transport);
    await createBlocksLink(http, { sourceKey: 'PROJ-1', targetKey: 'PROJ-2' });
    const body = JSON.parse(r.calls[0].body);
    expect(body.type.name).toBe('Blocks');
    expect(body.inwardIssue.key).toBe('PROJ-1');     // PROJ-1 is blocked by PROJ-2
    expect(body.outwardIssue.key).toBe('PROJ-2');
  });
  it('deleteLink uses DELETE on the link id', async () => {
    const r = recordingTransport([{ status: 204 }]);
    const http = httpFor(r.transport);
    await deleteLink(http, '10042');
    expect(r.calls[0].url).toContain('/issueLink/10042');
    expect(r.calls[0].method).toBe('DELETE');
  });
  it('listBlocksLinks returns inbound blockers only', async () => {
    // Real Jira echoes only the OPPOSITE end of each link, never the fetched
    // issue itself. For PROJ-1:
    //   - a blocked-by edge (PROJ-2 blocks PROJ-1) appears as outwardIssue: PROJ-2
    //   - an outbound edge (PROJ-1 blocks PROJ-3) appears as inwardIssue: PROJ-3
    const r = recordingTransport([{
      status: 200,
      body: {
        fields: {
          issuelinks: [
            { id: '1', type: { name: 'Blocks' }, outwardIssue: { key: 'PROJ-2' } }, // PROJ-1 is blocked by PROJ-2
            { id: '2', type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-3' } },  // PROJ-1 blocks PROJ-3 — outbound, not a blocker
            { id: '3', type: { name: 'Relates' }, inwardIssue: { key: 'PROJ-4' } },
          ],
        },
      },
    }]);
    const http = httpFor(r.transport);
    const out = await listBlocksLinks(http, 'PROJ-1');
    expect(out).toEqual([{ id: '1', blockerKey: 'PROJ-2' }]);
  });
});
