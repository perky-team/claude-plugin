// E2E for p-flow's /p-flow:init.
//
// p-flow has no CLI binary — the init flow is documented in
// `plugins/p-flow/skills/init/SKILL.md` and executed by Claude itself
// (via Bash + Write tools). So "subprocess E2E" doesn't apply directly.
//
// Instead, this test programmatically re-implements the init algorithm
// from SKILL.md against a real temp filesystem and asserts on the
// resulting layout + content. It acts as an executable spec for the init
// flow — if the SKILL.md changes, this test should change with it.
//
// Always runs in `npm test` (no external dependencies).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TPL_DIR = resolve(__dirname, '..', 'plugins', 'p-flow', 'skills', '_shared', 'templates');

function readTpl(name: string) {
  return readFileSync(join(TPL_DIR, name), 'utf-8');
}

// Re-implementation of the merge logic from SKILL.md §Step 5.
// Returns { merged, addedDenies, error? }.
function mergeSettings(existing: any, templateSettings: any) {
  if (existing === null || existing === undefined) {
    // Case A — file missing: write template verbatim.
    return { merged: templateSettings, addedDenies: [...(templateSettings.permissions?.deny ?? [])] };
  }
  if (typeof existing !== 'object') {
    return { error: 'existing settings.json is not a JSON object' };
  }
  // Validate existing shape.
  if (existing.permissions !== undefined && (existing.permissions === null || typeof existing.permissions !== 'object' || Array.isArray(existing.permissions))) {
    return { error: 'permissions is not an object' };
  }
  if (existing.permissions?.deny !== undefined && !Array.isArray(existing.permissions.deny)) {
    return { error: 'permissions.deny is not an array' };
  }
  // Merge.
  const merged = { ...existing };
  const permissions = { ...(existing.permissions ?? {}) };
  const existingDeny = [...(permissions.deny ?? [])];
  const newEntries = (templateSettings.permissions?.deny ?? []).filter((d: string) => !existingDeny.includes(d));
  permissions.deny = [...existingDeny, ...newEntries];
  merged.permissions = permissions;
  return { merged, addedDenies: newEntries };
}

// Programmatic implementation of SKILL.md Steps 3–5.
// (Skip Step 1's `git rev-parse` and Step 2's pre-existence check — the test
// controls the temp root and asserts the not-initialised path.)
function runInit(root: string) {
  // Step 3 — directories
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'templates', 'p-flow'), { recursive: true });

  // Step 4 — copy verbatim templates
  const copies: Array<[string, string]> = [
    ['rules-p-flow.template.md', '.claude/rules/p-flow.md'],
    ['adr.template.md', '.claude/templates/p-flow/adr.md'],
    ['feature-spec.template.feature', '.claude/templates/p-flow/feature-spec.feature'],
    ['specification.template.md', '.claude/templates/p-flow/specification.md'],
  ];
  for (const [src, dst] of copies) {
    writeFileSync(join(root, dst), readTpl(src), 'utf-8');
  }

  // Step 5 — merge settings.json
  const settingsPath = join(root, '.claude', 'settings.json');
  const template = JSON.parse(readTpl('settings.template.json'));
  let existing: any = null;
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')); }
    catch { throw new Error('existing settings.json is not valid JSON'); }
  }
  const { merged, error } = mergeSettings(existing, template);
  if (error) throw new Error(error);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p-flow-init-e2e-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('p-flow init E2E', () => {
  it('creates all expected directories and files on a clean repo', () => {
    runInit(dir);
    expect(existsSync(join(dir, '.claude', 'rules', 'p-flow.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'templates', 'p-flow', 'adr.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'templates', 'p-flow', 'feature-spec.feature'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'templates', 'p-flow', 'specification.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
  });

  it('copies templates byte-for-byte (no placeholder expansion)', () => {
    runInit(dir);
    const writtenRule = readFileSync(join(dir, '.claude', 'rules', 'p-flow.md'), 'utf-8');
    expect(writtenRule).toBe(readTpl('rules-p-flow.template.md'));

    const writtenAdr = readFileSync(join(dir, '.claude', 'templates', 'p-flow', 'adr.md'), 'utf-8');
    expect(writtenAdr).toBe(readTpl('adr.template.md'));
  });

  it('on clean repo writes settings.json with full deny list from template', () => {
    runInit(dir);
    const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    const template = JSON.parse(readTpl('settings.template.json'));
    expect(written.permissions.deny).toEqual(template.permissions.deny);
    expect(written.permissions.deny.length).toBeGreaterThan(0);
  });

  it('merges deny list when settings.json already exists, preserving existing entries', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const pre = {
      permissions: {
        deny: ['Read(/**/custom-secret)'],
        allow: ['Bash(npm test:*)'],
      },
      env: { CI: 'true' },
    };
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(pre, null, 2), 'utf-8');

    runInit(dir);

    const merged = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    // Existing entry is preserved at the head of the deny list
    expect(merged.permissions.deny[0]).toBe('Read(/**/custom-secret)');
    // Template entries are appended
    expect(merged.permissions.deny).toContain('Read(.env*)');
    expect(merged.permissions.deny).toContain('Edit(.env*)');
    // Other keys are untouched
    expect(merged.permissions.allow).toEqual(['Bash(npm test:*)']);
    expect(merged.env).toEqual({ CI: 'true' });
  });

  it('does not duplicate deny entries when re-merging the same template', () => {
    runInit(dir);
    const first = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    runInit(dir);  // simulated re-init (would normally be blocked by Step 2; we're testing the merge alone)
    const second = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(second.permissions.deny.length).toBe(first.permissions.deny.length);
    // Each entry occurs exactly once
    const counts = new Map<string, number>();
    for (const d of second.permissions.deny) counts.set(d, (counts.get(d) ?? 0) + 1);
    for (const [k, v] of counts) expect(v, `${k} duplicated`).toBe(1);
  });

  it('rejects a settings.json with non-object permissions', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: 'oops' }), 'utf-8');
    expect(() => runInit(dir)).toThrow(/permissions is not an object/);
  });

  it('rejects a settings.json where permissions.deny is not an array', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: 'oops' } }), 'utf-8');
    expect(() => runInit(dir)).toThrow(/permissions\.deny is not an array/);
  });

  it('rejects a settings.json that is not valid JSON', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{not json', 'utf-8');
    expect(() => runInit(dir)).toThrow(/not valid JSON/);
  });

  it('all template files are non-empty and well-formed', () => {
    // Sanity gate on the shipped templates.
    const names = ['rules-p-flow.template.md', 'adr.template.md', 'feature-spec.template.feature', 'specification.template.md', 'settings.template.json'];
    for (const n of names) {
      const text = readTpl(n);
      expect(text.trim().length, `${n} empty`).toBeGreaterThan(0);
    }
    const settings = JSON.parse(readTpl('settings.template.json'));
    expect(Array.isArray(settings.permissions?.deny)).toBe(true);
    expect(settings.permissions.deny.length).toBeGreaterThan(0);
  });
});
