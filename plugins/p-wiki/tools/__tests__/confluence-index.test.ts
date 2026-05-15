import { describe, expect, it } from 'vitest';
import { renderIndexAdf } from '../lib/confluence/index.mjs';

describe('renderIndexAdf', () => {
  it('builds heading per group and bullet list of items', () => {
    const adf = renderIndexAdf({
      siteUrl: 'https://x', spaceKey: 'ENG',
      groups: {
        concept: [{ id: 'foo', title: 'Foo', numericId: '200', summary: 'About Foo.' }],
        person: [], source: [], query: [],
      },
    });
    expect(adf.type).toBe('doc');
    expect(adf.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    const list = adf.content.find((b: any) => b.type === 'bulletList');
    expect(list).toBeDefined();
    const json = JSON.stringify(list);
    expect(json).toContain('/pages/200');
    expect(json).toContain('Foo');
  });
});
