// http-bundle.test.ts
import { describe, expect, it } from 'vitest';
import { createHttpBundleSource } from '../lib/destinations/http-bundle.mjs';

const BUNDLE = {
  schema: 1, generated: '2026-07-01', wikiRoot: 'docs/wiki',
  pages: [{
    type: 'concept', id: 'kafka', path: 'docs/wiki/pages/concept/kafka.md',
    frontmatter: { id: 'kafka', type: 'concept', title: 'Kafka', tags: ['infra'] },
    body: '# Kafka\n\nStreaming platform.',
  }],
};
const b64 = (o: any) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64');

// gitlab/github wrap the bundle as {content, encoding:"base64"} in a JSON body
const okGitJson = async () => ({ status: 200, headers: {}, body: { content: b64(BUNDLE), encoding: 'base64' } });
// http serves the parsed bundle object directly
const okHttp = async () => ({ status: 200, headers: {}, body: BUNDLE });

describe('createHttpBundleSource', () => {
  it('gitlab: base64-decodes the JSON body and searches', async () => {
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: okGitJson, env: {} });
    const r = await src.search('kafka', {});
    expect(r.results[0].path).toBe('docs/wiki/pages/concept/kafka.md');
  });
  it('http: uses the parsed body object directly and reads a page', async () => {
    const src = createHttpBundleSource({ kind: 'http', destinationConfig: { kind: 'http', url: 'https://x/index.json' }, transport: okHttp, env: {} });
    const p = await src.readPage('docs/wiki/pages/concept/kafka.md');
    expect(p.frontmatter.title).toBe('Kafka');
  });
  it('readPage throws page-not-found for a missing path', async () => {
    const src = createHttpBundleSource({ kind: 'http', destinationConfig: { kind: 'http', url: 'https://x' }, transport: okHttp, env: {} });
    await expect(src.readPage('docs/wiki/pages/concept/nope.md')).rejects.toThrow(/page not found/);
  });
  it('non-2xx throws an err.status-carrying error', async () => {
    const failing = async () => ({ status: 404, headers: {}, body: null });
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: failing, env: {} });
    await expect(src.search('x', {})).rejects.toMatchObject({ status: 404 });
  });
  it('malformed bundle throws err.code=bundle-invalid', async () => {
    const bad = async () => ({ status: 200, headers: {}, body: { content: Buffer.from('not json', 'utf-8').toString('base64'), encoding: 'base64' } });
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: bad, env: {} });
    await expect(src.search('x', {})).rejects.toMatchObject({ code: 'bundle-invalid' });
  });
  it('attaches the auth header only when the env token is set', async () => {
    let seen: any;
    const spy = async (req: any) => { seen = req.headers; return okGitJson(); };
    const src = createHttpBundleSource({ kind: 'gitlab', destinationConfig: { kind: 'gitlab', project: 'g/p' }, transport: spy, env: { PWIKI_GITLAB_TOKEN: 'tok' } });
    await src.search('kafka', {});
    expect(seen['PRIVATE-TOKEN']).toBe('tok');
  });
});
