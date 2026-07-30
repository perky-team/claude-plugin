import { describe, expect, it } from 'vitest';
import { classifyUpdate, pendingFreeTexts } from '../lib/queue.mjs';

const cfg = { allowedChatIds: [111], commands: { '/status': 'echo ok', '/jobs': 'echo jobs' } };
let id = 0;
const msg = (chatId: number, text?: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: ++id, message: { message_id: id, date: 1_750_000_000, chat: { id: chatId }, ...(text !== undefined ? { text } : {}), ...extra } });

describe('classifyUpdate — the injection boundary', () => {
  it('an exact command match (after trim) from an allowed chat is a command', () => {
    expect(classifyUpdate(msg(111, '  /status '), cfg)).toMatchObject({ kind: 'command', command: '/status', chatId: 111 });
  });

  it('free text from an allowed chat is free', () => {
    expect(classifyUpdate(msg(111, 'how is the loop doing?'), cfg)).toMatchObject({ kind: 'free', text: 'how is the loop doing?' });
  });

  it('NO prefix match and NO interpolation: "/status; echo pwned" is free text, not a command', () => {
    expect(classifyUpdate(msg(111, '/status; echo pwned'), cfg).kind).toBe('free');
    expect(classifyUpdate(msg(111, '/status extra-arg'), cfg).kind).toBe('free');
  });

  it('a command word from a NON-allowed chat is other (never replied, never executed)', () => {
    expect(classifyUpdate(msg(999, '/status'), cfg).kind).toBe('other');
  });

  it('non-text updates (stickers, service events) are other', () => {
    expect(classifyUpdate(msg(111, undefined, { sticker: {} }), cfg).kind).toBe('other');
    expect(classifyUpdate({ update_id: ++id, my_chat_member: {} } as never, cfg).kind).toBe('other');
  });

  it('does not treat Object.prototype members as commands', () => {
    expect(classifyUpdate(msg(111, 'constructor'), cfg).kind).toBe('free');
  });
});

describe('pendingFreeTexts — contiguous prefix, stop before the first command (B1)', () => {
  it('returns [q1] for [q1, /status, q2] — acking q1 must not confirm the unexecuted /status', () => {
    const q1 = msg(111, 'question one');
    const cmd = msg(111, '/status');
    const q2 = msg(111, 'question two');
    const got = pendingFreeTexts([q1, cmd, q2], cfg);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ updateId: q1.update_id, text: 'question one' });
  });

  it('collects consecutive questions and skips "other" noise in between', () => {
    const q1 = msg(111, 'q1');
    const noise = msg(999, 'spam');
    const q2 = msg(111, 'q2');
    expect(pendingFreeTexts([q1, noise, q2], cfg).map((p: { text: string }) => p.text)).toEqual(['q1', 'q2']);
  });

  it('returns [] when the queue starts with a command or is empty', () => {
    expect(pendingFreeTexts([msg(111, '/status'), msg(111, 'q')], cfg)).toEqual([]);
    expect(pendingFreeTexts([], cfg)).toEqual([]);
  });
});
