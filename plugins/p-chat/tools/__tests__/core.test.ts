import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardScan, initDiscover, listPending } from '../lib/core.mjs';
import { readOffset, writeOffset } from '../lib/state.mjs';
import { ConfigError } from '../lib/config.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pchat-core-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const cfg = { allowedChatIds: [111], defaultChatId: 111, commands: { '/status': 'run-status-tool' }, commandTimeoutSec: 15 };
let id = 100;
const msg = (chatId: number, text?: string) =>
  ({ update_id: ++id, message: { message_id: id, date: 1, chat: { id: chatId }, ...(text !== undefined ? { text } : {}) } });

const fakes = (overrides: Record<string, unknown> = {}) => ({
  runShell: vi.fn(async () => ({ exit: 0, timedOut: false, out: 'all green', err: '' })),
  sendText: vi.fn(async () => ({ chatId: 111, parts: 1 })),
  appendLocalLog: vi.fn(),
  ...overrides,
});

describe('guardScan', () => {
  it('empty queue -> quiet', async () => {
    const api = { getUpdates: vi.fn(async () => []) };
    const r = await guardScan({ root, cfg, api: api as never, deps: fakes() });
    expect(r.result).toBe('quiet');
  });

  it('free text from an allowed chat -> work, message stays UNCONFIRMED', async () => {
    const q = msg(111, 'how is it going?');
    const api = { getUpdates: vi.fn(async () => [q]) };
    const r = await guardScan({ root, cfg, api: api as never, deps: fakes() });
    expect(r.result).toBe('work');
    expect(readOffset(root).confirmed).toBe(0); // NOT past the question
  });

  it('a scripted command runs, its output is sent back, cursor advances, then quiet', async () => {
    const c = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [c]) };
    const d = fakes();
    const r = await guardScan({ root, cfg, api: api as never, deps: d });
    expect(r.result).toBe('quiet');
    expect(d.runShell).toHaveBeenCalledWith('run-status-tool', expect.objectContaining({ timeoutSec: 15 }));
    expect(d.sendText).toHaveBeenCalledOnce();
    expect((d.sendText as any).mock.calls[0][0].text).toContain('all green');
    expect(readOffset(root).confirmed).toBe(c.update_id);
  });

  it('a failing command still answers (exit marker) and advances', async () => {
    const c = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [c]) };
    const d = fakes({ runShell: vi.fn(async () => ({ exit: 3, timedOut: false, out: '', err: 'db down' })) });
    await guardScan({ root, cfg, api: api as never, deps: d });
    expect((d.sendText as any).mock.calls[0][0].text).toMatch(/exit 3/);
    expect(readOffset(root).confirmed).toBe(c.update_id);
  });

  it('processes strictly in order and STOPS at the first free text: [other, /status, q, /status]', async () => {
    const spam = msg(999, 'spam');
    const c = msg(111, '/status');
    const q = msg(111, 'question');
    const c2 = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [spam, c, q, c2]) };
    const d = fakes();
    const r = await guardScan({ root, cfg, api: api as never, deps: d });
    expect(r.result).toBe('work');
    expect(d.runShell).toHaveBeenCalledTimes(1);           // only the command BEFORE the question
    expect(readOffset(root).confirmed).toBe(c.update_id);  // cursor never jumps the question
  });

  it('at-least-once for commands: a send failure leaves the command unconfirmed', async () => {
    const c = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [c]) };
    const d = fakes({ sendText: vi.fn(async () => { throw new Error('network'); }) });
    await expect(guardScan({ root, cfg, api: api as never, deps: d })).rejects.toThrow();
    expect(readOffset(root).confirmed).toBe(0); // re-served and re-run next pass
  });

  it('an empty allowlist is a hard error (exit 2 path), never quiet', async () => {
    const api = { getUpdates: vi.fn(async () => []) };
    await expect(guardScan({ root, cfg: { ...cfg, allowedChatIds: [] }, api: api as never, deps: fakes() })).rejects.toThrow(ConfigError);
  });
});

describe('listPending', () => {
  it('returns the free-text prefix and updates lastPollAt without moving the cursor', async () => {
    writeOffset(root, { confirmed: 50, lastPollAt: null });
    const q = msg(111, 'q1');
    const api = { getUpdates: vi.fn(async () => [q, msg(111, '/status'), msg(111, 'q2')]) };
    const got = await listPending({ root, cfg, api: api as never });
    expect(got.map((p: { text: string }) => p.text)).toEqual(['q1']);
    expect(api.getUpdates).toHaveBeenCalledWith(51);
    expect(readOffset(root).confirmed).toBe(50);
    expect(readOffset(root).lastPollAt).not.toBeNull();
  });
});

describe('initDiscover', () => {
  it('discovers the chat id from the newest message and baselines the cursor', async () => {
    const a = msg(111, 'hi');
    const b = msg(222, 'yo');
    const api = { getMe: vi.fn(async () => ({ username: 'bot' })), getUpdates: vi.fn(async () => [a, b]) };
    const r = await initDiscover({ api: api as never });
    expect(r.chatId).toBe(222);
    expect(r.confirmed).toBe(b.update_id);
  });

  it('respects an explicit chatId but still baselines', async () => {
    const a = msg(111, 'hi');
    const api = { getMe: vi.fn(async () => ({ username: 'bot' })), getUpdates: vi.fn(async () => [a]) };
    const r = await initDiscover({ api: api as never, chatId: 555 });
    expect(r.chatId).toBe(555);
    expect(r.confirmed).toBe(a.update_id);
  });

  it('throws when no chatId given and no updates pending', async () => {
    const api = { getMe: vi.fn(async () => ({ username: 'bot' })), getUpdates: vi.fn(async () => []) };
    await expect(initDiscover({ api: api as never })).rejects.toThrow(/message first/);
  });
});
