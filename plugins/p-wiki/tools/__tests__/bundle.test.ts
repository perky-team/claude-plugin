import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../lib/bundle.mjs';
import { createFsDestination } from '../lib/destinations/fs.mjs';
import { createHttpBundleSource } from '../lib/destinations/http-bundle.mjs';

const PAGE = (id: string) => `---\nid: ${id}\ntype: concept\ntitle: ${id}\ntags: []\n---\n\n# ${id}\n\nbody of ${id}.\n`;

describe('buildBundle + round-trip', () => {
  it('captures pages/ (not raw/) and round-trips through the http reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pwiki-bundle-'));
    mkdirSync(join(root, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    mkdirSync(join(root, 'docs', 'wiki', 'raw', 'articles'), { recursive: true });
    writeFileSync(join(root, 'docs', 'wiki', 'pages', 'concept', 'a.md'), PAGE('a'));
    writeFileSync(join(root, 'docs', 'wiki', 'raw', 'articles', 'skip.md'), PAGE('skip'));

    const fs = createFsDestination({ root });
    const bundle = buildBundle(fs);
    expect(bundle.schema).toBe(1);
    expect(bundle.pages.map(p => p.id).sort()).toEqual(['a']); // raw/ excluded

    const src = createHttpBundleSource({ kind: 'http', destinationConfig: { kind: 'http', url: 'x' },
      transport: async () => ({ status: 200, headers: {}, body: bundle }), env: {} });
    const r = await src.search('body', {});
    expect(r.results[0].path).toBe('docs/wiki/pages/concept/a.md');
    rmSync(root, { recursive: true, force: true });
  });
});
