import { describe, expect, it } from 'vitest';
import { syncAll } from '../lib/sync.mjs';

// Build two in-memory destinations that follow the Destination contract.
function memDest(name: string, opts: { kind: 'fs' | 'jira' } = { kind: 'fs' }) {
  const items: any[] = [];
  let n = 0;
  return {
    kind: opts.kind, name,
    state: items,
    async ensureStructure() {},
    async listItems() { return items.map(i => ({ ...i })); },
    async readItem(id: string) { const x = items.find(i => i.id === id); if (!x) throw Object.assign(new Error('item-not-found'), { code: 'item-not-found' }); return { ...x }; },
    async createItem(input: any) {
      const id = opts.kind === 'jira' ? `Q-${++n}` : `t-${++n}`;
      const newItem = { id, type: input.type, parentId: input.parentId, title: input.title, description: input.description ?? '', status: input.status ?? 'todo', blockedBy: [] };
      items.push(newItem);
      return { ...newItem };
    },
    async updateItem(id: string, patch: any) {
      const x = items.find(i => i.id === id);
      if (!x) throw Object.assign(new Error('item-not-found'), { code: 'item-not-found' });
      Object.assign(x, patch);
      return { ...x };
    },
  };
}

describe('syncAll', () => {
  it('creates missing items on the mirror', async () => {
    const primary = memDest('fs');
    await primary.createItem({ type: 'task', title: 'A' });
    await primary.createItem({ type: 'task', title: 'B' });
    const mirror = memDest('m');
    const out = await syncAll({ primary, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] });
    expect(out).toHaveLength(1);
    expect(out[0].created).toBe(2);
    expect(out[0].errors).toEqual([]);
  });
  it('is idempotent — second run does nothing', async () => {
    const primary = memDest('fs');
    await primary.createItem({ type: 'task', title: 'A' });
    const mirror = memDest('m');
    await syncAll({ primary, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] });
    const out = await syncAll({ primary, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] });
    expect(out[0].created).toBe(0);
    expect(out[0].updated + out[0].linksAdded + out[0].linksRemoved).toBe(0);
  });
  it('mirror A failure does not stop mirror B', async () => {
    const primary = memDest('fs');
    await primary.createItem({ type: 'task', title: 'A' });
    const broken = { ...memDest('A'), ensureStructure: async () => { throw Object.assign(new Error('boom'), { code: 'network-error' }); } };
    const good = memDest('B');
    const out = await syncAll({ primary, primaryName: 'fs', mirrors: [broken as any, good], mirrorNames: ['A', 'B'] });
    expect(out[0].errors[0].code).toBe('network-error');
    expect(out[1].created).toBe(1);
  });
  it('aborts entirely if primary listItems fails (primary-side error)', async () => {
    const primary = { ...memDest('fs'), listItems: async () => { throw Object.assign(new Error('boom'), { code: 'network-error' }); } };
    const mirror = memDest('m');
    await expect(syncAll({ primary: primary as any, primaryName: 'fs', mirrors: [mirror], mirrorNames: ['m'] }))
      .rejects.toMatchObject({ code: 'network-error' });
  });
});
