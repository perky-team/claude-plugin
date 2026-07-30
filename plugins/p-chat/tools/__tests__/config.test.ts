import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, expandHome, paths, readConfig, readToken, requireAllowlist, tokenPermsWarning } from '../lib/config.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pchat-config-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const writeCfg = (obj: Record<string, unknown>) =>
  writeFileSync(paths(root).config, JSON.stringify(obj), 'utf-8');

describe('config', () => {
  it('readConfig throws ConfigError when .pchat.json is missing', () => {
    expect(() => readConfig(root)).toThrow(ConfigError);
  });

  it('readConfig merges defaults (apiBase, sessionFile, commandTimeoutSec, commands)', () => {
    writeCfg({ tokenFile: 't', allowedChatIds: [1] });
    const cfg = readConfig(root);
    expect(cfg.apiBase).toBe('https://api.telegram.org');
    expect(cfg.sessionFile).toBe('.pchat/session.md');
    expect(cfg.commandTimeoutSec).toBe(15);
    expect(cfg.commands).toEqual({});
  });

  it('readConfig throws ConfigError on corrupt JSON', () => {
    writeFileSync(paths(root).config, '{oops', 'utf-8');
    expect(() => readConfig(root)).toThrow(ConfigError);
  });

  it('requireAllowlist rejects an empty or missing allowlist (fail-closed)', () => {
    expect(() => requireAllowlist({})).toThrow(ConfigError);
    expect(() => requireAllowlist({ allowedChatIds: [] })).toThrow(ConfigError);
    expect(requireAllowlist({ allowedChatIds: [7] })).toEqual([7]);
  });

  it('expandHome expands ~/ to the home directory', () => {
    expect(expandHome('~/x/y')).toBe(join(homedir(), 'x/y'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });

  it('readToken reads and trims the token file, relative to root', () => {
    writeFileSync(join(root, 'tok'), '  123:ABC \n', 'utf-8');
    expect(readToken({ tokenFile: 'tok' }, root)).toBe('123:ABC');
  });

  it('readToken throws on a missing or empty token file', () => {
    expect(() => readToken({ tokenFile: 'nope' }, root)).toThrow(ConfigError);
    writeFileSync(join(root, 'empty'), '  \n', 'utf-8');
    expect(() => readToken({ tokenFile: 'empty' }, root)).toThrow(ConfigError);
    expect(() => readToken({}, root)).toThrow(ConfigError);
  });

  it.runIf(process.platform !== 'win32')('tokenPermsWarning warns on group/other-readable modes (POSIX)', () => {
    writeFileSync(join(root, 'tok'), 'x', 'utf-8');
    chmodSync(join(root, 'tok'), 0o644);
    expect(tokenPermsWarning({ tokenFile: 'tok' }, root)).toMatch(/chmod 600/);
    chmodSync(join(root, 'tok'), 0o600);
    expect(tokenPermsWarning({ tokenFile: 'tok' }, root)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('tokenPermsWarning is null on Windows (mode is meaningless)', () => {
    writeFileSync(join(root, 'tok'), 'x', 'utf-8');
    expect(tokenPermsWarning({ tokenFile: 'tok' }, root)).toBeNull();
  });
});
