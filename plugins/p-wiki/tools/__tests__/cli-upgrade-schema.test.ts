import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `init` writes docs/wiki/CLAUDE.md once and never rewrites it, so a rule added to the
// shipped template reaches new wikis only. `upgrade-schema` is the path that carries the
// change into a wiki that already exists: report the drift, and only replace the file when
// asked. It must be line-ending agnostic in both directions — the template is checked in
// with CRLF and a wiki's copy is usually LF, so a byte comparison would call every line
// changed and a verbatim write would rewrite the whole file in the user's repo.

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..', 'pwiki.mjs');
const template = readFileSync(
  resolve(here, '..', '..', 'skills', '_shared', 'templates', 'wiki-claude-md.template.md'),
  'utf-8',
);
const templateLf = template.replace(/\r\n/g, '\n');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}
const target = () => join(dir, 'docs', 'wiki', 'CLAUDE.md');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-upgrade-schema-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki upgrade-schema', () => {
  it('reports drift and writes nothing without --write', () => {
    writeFileSync(target(), '# old rules\n\nonly this line\n');

    const r = runCli(['upgrade-schema', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.inSync).toBe(false);
    expect(json.wrote).toBe(false);
    expect(json.added).toBeGreaterThan(0);
    expect(json.target).toBe('docs/wiki/CLAUDE.md');
    // untouched
    expect(readFileSync(target(), 'utf-8')).toBe('# old rules\n\nonly this line\n');
  });

  it('--write installs the shipped schema, and a second run reports in-sync', () => {
    writeFileSync(target(), '# old rules\n');

    const first = runCli(['upgrade-schema', '--write', '--format=json']);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).wrote).toBe(true);
    expect(readFileSync(target(), 'utf-8')).toBe(templateLf);

    const second = runCli(['upgrade-schema', '--format=json']);
    const json = JSON.parse(second.stdout);
    expect(json.inSync).toBe(true);
    expect(json.wrote).toBe(false);
    expect(json.added).toBe(0);
    expect(json.removed).toBe(0);
  });

  it('treats a CRLF copy of the same content as in sync', () => {
    writeFileSync(target(), templateLf.replace(/\n/g, '\r\n'));

    const r = runCli(['upgrade-schema', '--format=json']);
    expect(JSON.parse(r.stdout).inSync).toBe(true);
  });

  it('--write keeps the line endings the target already uses', () => {
    writeFileSync(target(), '# old rules\r\nsecond line\r\n');

    runCli(['upgrade-schema', '--write']);
    const after = readFileSync(target(), 'utf-8');
    expect(after).toBe(templateLf.replace(/\n/g, '\r\n'));
    expect(after).not.toContain('\n\n\n'); // no doubled endings from a bad replace
  });

  it('surfaces a single missing compile rule as an addition', () => {
    // The realistic migration: a wiki whose CLAUDE.md is one release behind. Seeding the
    // target with the whole template minus the identifiers rule keeps the drift small, so
    // the reported line list is the assertion rather than an artifact of truncation — with
    // a from-scratch target the rule sits past the 40-line report cap.
    const withoutRule = templateLf
      .split('\n')
      .filter(l => !l.includes('Identifiers verbatim'))
      .join('\n');
    writeFileSync(target(), withoutRule);

    const r = runCli(['upgrade-schema', '--format=json']);
    const json = JSON.parse(r.stdout);
    expect(json.inSync).toBe(false);
    expect(json.added).toBe(1);
    expect(json.addedLines.some((l: string) => l.includes('Identifiers verbatim'))).toBe(true);
  });

  it('fails outside a p-wiki repo', () => {
    rmSync(join(dir, 'docs'), { recursive: true, force: true });
    const r = runCli(['upgrade-schema']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not inside a p-wiki repo');
  });
});
