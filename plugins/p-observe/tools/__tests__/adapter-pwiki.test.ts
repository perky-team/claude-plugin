import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPwikiAdapter, readFrontmatter, derivePagesMeta } from '../lib/adapters/pwiki.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-pwiki-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const page = (fm: Record<string, string>) =>
  '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\nbody\n';

describe('readFrontmatter', () => {
  it('parses the leading fenced block', () => {
    expect(readFrontmatter(page({ title: 'X', 'conflict-since': '2026-06-05' }))['conflict-since']).toBe('2026-06-05');
  });
  it('returns {} when there is no frontmatter', () => {
    expect(readFrontmatter('no fm here')).toEqual({});
  });
});

describe('pwiki adapter', () => {
  function mk() {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.wikiPagesDir, { recursive: true });
    const events: any[] = [];
    const a = createPwikiAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    return { cfg, p, events, a };
  }

  it('emits wiki.conflict when conflict-since appears', () => {
    const { p, events, a } = mk();
    const f = join(p.wikiPagesDir, 'concept', 'auth.md');
    mkdirSync(join(p.wikiPagesDir, 'concept'), { recursive: true });
    writeFileSync(f, page({ title: 'Auth' }));
    a.backfill();
    writeFileSync(f, page({ title: 'Auth', 'conflict-since': '2026-07-17' }));
    a._scanNow();
    expect(events.find((e) => e.kind === 'wiki.conflict')).toMatchObject({ plugin: 'p-wiki', severity: 'warn' });
  });

  it('is disabled for a Confluence-primary wiki with no fs mirror', () => {
    const { p, a } = mk();
    writeFileSync(p.pwikiConfig, JSON.stringify({ primary: 'confluence', mirrors: [] }));
    expect(a.enabled()).toBe(false);
  });

  it('emits wiki.reindex only when index.json mtime changes', () => {
    const { p, events, a } = mk();
    a._checkReindex();                       // no index.json yet -> nothing
    writeFileSync(p.wikiIndexJson, '{}');
    a._checkReindex();                       // first observation -> seed, no emit
    const future = new Date(Date.now() + 2000);
    utimesSync(p.wikiIndexJson, future, future); // simulate regeneration (new mtime)
    a._checkReindex();
    expect(events.filter((e) => e.kind === 'wiki.reindex')).toHaveLength(1);
  });
});

const bundle = (pages: any[]) => JSON.stringify({ schema: 1, pages }, null, 2) + '\n';

describe('derivePagesMeta', () => {
  const pages = [
    { type: 'concept', id: 'auth', path: 'pages/concept/auth.md',
      frontmatter: { title: 'Auth', type: 'concept', tags: ['security'], id: 'auth' },
      body: '# Auth\n\nHow login works. See [[session]].\n' },
    { type: 'concept', id: 'session', path: 'pages/concept/session.md',
      frontmatter: { title: 'Session', id: 'session' },
      body: 'Session details.\n' },
    { type: 'note', id: 'lonely', path: 'pages/lonely.md',
      frontmatter: { title: 'Lonely', id: 'lonely' }, body: 'Nothing links here or out.\n' },
  ];
  it('derives frontmatter, summary, links, backlinks and orphan flag', () => {
    const m = derivePagesMeta(pages);
    expect(m['auth.md']).toMatchObject({ title: 'Auth', type: 'concept', summary: 'How login works. See [[session]].' });
    expect(m['auth.md'].outlinks).toContain('session.md');
    expect(m['session.md'].backlinks).toContain('auth.md');
    expect(m['session.md'].orphan).toBe(false);
    expect(m['lonely.md'].orphan).toBe(true);
  });
});

describe('pwiki adapter pagesMeta', () => {
  it('status() parses index.json into pagesMeta and caches it on a torn write', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    mkdirSync(p.wikiPagesDir, { recursive: true });
    const a = createPwikiAdapter({ root, paths: p, cfg, emit: () => {} });
    writeFileSync(p.wikiIndexJson, bundle([
      { type: 'concept', id: 'auth', path: 'pages/auth.md', frontmatter: { title: 'Auth', id: 'auth' }, body: 'x\n' },
    ]));
    a.backfill();
    expect(a.status().pagesMeta['auth.md'].title).toBe('Auth');
    writeFileSync(p.wikiIndexJson, '{ "pages": ['); // torn, no trailing newline
    a.backfill(); // refreshIndex hits the torn gate deterministically; cache kept
    expect(a.status().pagesMeta['auth.md'].title).toBe('Auth'); // cached, not clobbered
  });
});
