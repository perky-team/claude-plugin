import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPwikiAdapter, readFrontmatter } from '../lib/adapters/pwiki.mjs';

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
});
