import { describe, expect, it, vi } from 'vitest';
import { sendText } from '../lib/send.mjs';
import { ApiError } from '../lib/api.mjs';
import { ConfigError } from '../lib/config.mjs';

const cfg = { allowedChatIds: [111, 222], defaultChatId: 111 };
const okApi = () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })) });

describe('sendText', () => {
  it('sends one Markdown chunk to the default chat', async () => {
    const api = okApi();
    const r = await sendText({ api: api as never, cfg, text: 'hello' });
    expect(r).toEqual({ chatId: 111, parts: 1 });
    expect(api.sendMessage).toHaveBeenCalledWith({ chat_id: 111, text: 'hello', parse_mode: 'Markdown' });
  });

  it('splits long text into multiple sends', async () => {
    const api = okApi();
    const r = await sendText({ api: api as never, cfg, text: 'x'.repeat(5000) });
    expect(r.parts).toBe(2);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('falls back to plain text when Telegram rejects the Markdown (400 parse error)', async () => {
    const calls: Array<{ parse_mode?: string }> = [];
    const api = {
      sendMessage: vi.fn(async (p: { parse_mode?: string }) => {
        calls.push(p);
        if (p.parse_mode) throw new ApiError('bad', { status: 400, description: "Bad Request: can't parse entities: ..." });
        return { message_id: 1 };
      }),
    };
    const r = await sendText({ api: api as never, cfg, text: 'unbalanced _markdown' });
    expect(r.parts).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(calls[1].parse_mode).toBeUndefined();
  });

  it('re-throws non-parse API errors', async () => {
    const api = { sendMessage: vi.fn(async () => { throw new ApiError('down', { status: 502 }); }) };
    await expect(sendText({ api: api as never, cfg, text: 'x' })).rejects.toThrow(ApiError);
  });

  it('REFUSES a --to target outside the allowlist', async () => {
    const api = okApi();
    await expect(sendText({ api: api as never, cfg, chatId: 999, text: 'leak' })).rejects.toThrow(ConfigError);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses empty text and a missing target', async () => {
    await expect(sendText({ api: okApi() as never, cfg, text: '' })).rejects.toThrow(ConfigError);
    await expect(sendText({ api: okApi() as never, cfg: { allowedChatIds: [1] }, text: 'x' })).rejects.toThrow(ConfigError);
  });
});
