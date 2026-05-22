// E2E for p-statusline's /p-statusline:init.
//
// p-statusline has no CLI binary — the init flow is documented in
// `plugins/p-statusline/skills/init/SKILL.md` and executed by Claude itself
// (via Bash + Read + Write). This test programmatically re-implements that
// algorithm against a real temp filesystem and asserts on the result. It is
// an executable spec: if SKILL.md changes, this test should change with it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(__dirname, '..', 'plugins', 'p-statusline');
// SKILL.md Step 2 resolves the node binary; the test fixes it to the runner's.
const NODE = process.execPath;

interface InitResult {
  created: boolean;
  backedUp: boolean;
  alreadyInstalled: boolean;
}

// Re-implementation of SKILL.md Steps 3-6 (Steps 1-2, 7 are environment /
// messaging and not exercised here).
function runInit(home: string): InitResult {
  const claudeDir = join(home, '.claude');
  const targetDir = join(claudeDir, 'p-statusline');
  const script = join(targetDir, 'statusline.cjs');
  const settingsPath = join(claudeDir, 'settings.json');

  // Step 3 — copy the script to the stable path.
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(PLUGIN_ROOT, 'statusline', 'statusline.cjs'), script);

  // Step 4 — read settings.json.
  let settings: Record<string, unknown>;
  let created = false;
  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      throw new Error('settings.json is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json root is not an object');
    }
    settings = parsed as Record<string, unknown>;
  } else {
    settings = {};
    created = true;
  }

  // Step 5 — protect an existing status line. Back up ANY existing statusLine
  // value that is not already ours — including a malformed (non-object, or
  // command-less) value — so nothing is ever silently discarded.
  const command = `"${NODE}" "${script}"`;
  let backedUp = false;
  let alreadyInstalled = false;
  const existing = settings.statusLine;
  if (existing !== undefined && existing !== null) {
    const cmd =
      typeof existing === 'object' &&
      typeof (existing as { command?: unknown }).command === 'string'
        ? (existing as { command: string }).command
        : '';
    if (cmd.includes('p-statusline/statusline.cjs') || cmd.includes('p-statusline\\statusline.cjs')) {
      alreadyInstalled = true;
    } else {
      writeFileSync(
        join(targetDir, 'statusline.prev.json'),
        JSON.stringify(existing, null, 2) + '\n',
        'utf-8',
      );
      backedUp = true;
    }
  }

  // Step 6 — write settings.json.
  settings.statusLine = { type: 'command', command };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  return { created, backedUp, alreadyInstalled };
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'p-statusline-init-e2e-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('p-statusline init E2E', () => {
  it('creates settings.json with only statusLine when none exists', () => {
    const r = runInit(home);
    expect(r.created).toBe(true);
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(Object.keys(s)).toEqual(['statusLine']);
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toContain('statusline.cjs');
    expect(s.statusLine.command).toMatch(/^".+" ".+statusline\.cjs"$/);
  });

  it('copies statusline.cjs into ~/.claude/p-statusline/', () => {
    runInit(home);
    expect(existsSync(join(home, '.claude', 'p-statusline', 'statusline.cjs'))).toBe(true);
  });

  it('preserves unrelated keys in an existing settings.json', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', theme: 'dark-ansi' }, null, 2),
      'utf-8',
    );
    runInit(home);
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(s.model).toBe('opus');
    expect(s.theme).toBe('dark-ansi');
    expect(s.statusLine.command).toContain('statusline.cjs');
  });

  it('backs up a foreign statusLine before replacing it', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const foreign = { type: 'command', command: 'bash /some/other/script.sh' };
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: foreign }, null, 2),
      'utf-8',
    );
    const r = runInit(home);
    expect(r.backedUp).toBe(true);
    const prev = JSON.parse(
      readFileSync(join(home, '.claude', 'p-statusline', 'statusline.prev.json'), 'utf-8'),
    );
    expect(prev).toEqual(foreign);
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(s.statusLine.command).toContain('statusline.cjs');
  });

  it('backs up a non-object statusLine value before replacing it', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: 'legacy-string-value' }, null, 2),
      'utf-8',
    );
    const r = runInit(home);
    expect(r.backedUp).toBe(true);
    const prev = JSON.parse(
      readFileSync(join(home, '.claude', 'p-statusline', 'statusline.prev.json'), 'utf-8'),
    );
    expect(prev).toBe('legacy-string-value');
  });

  it('is idempotent when already pointing at our script', () => {
    runInit(home);
    const r = runInit(home);
    expect(r.alreadyInstalled).toBe(true);
    expect(existsSync(join(home, '.claude', 'p-statusline', 'statusline.prev.json'))).toBe(false);
  });

  it('rejects a settings.json that is not valid JSON', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json', 'utf-8');
    expect(() => runInit(home)).toThrow(/not valid JSON/);
  });

  it('rejects a settings.json whose root is not an object', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '["array"]', 'utf-8');
    expect(() => runInit(home)).toThrow(/not an object/);
  });
});
