import { splitMessage } from './split.mjs';
import { ApiError } from './api.mjs';
import { ConfigError, requireAllowlist } from './config.mjs';

// Deliver text to an allowlisted chat: split at the Telegram cap, try Markdown
// first, retry a rejected chunk as plain text (delivery beats formatting).
// Refuses any target outside allowedChatIds: a compromised or confused prompt
// cannot exfiltrate to an arbitrary chat.
export async function sendText({ api, cfg, chatId, text, log = () => {} }) {
  const allowed = requireAllowlist(cfg);
  const target = chatId ?? cfg.defaultChatId;
  if (target == null) throw new ConfigError('no chat id: pass --to or set defaultChatId in .pchat.json');
  if (!allowed.includes(target)) throw new ConfigError(`chat ${target} is not in allowedChatIds — refusing to send`);
  const chunks = splitMessage(text);
  if (chunks.length === 0) throw new ConfigError('nothing to send: empty text');
  if (chunks.length > 1) log({ event: 'split', parts: chunks.length });
  for (const chunk of chunks) {
    try {
      await api.sendMessage({ chat_id: target, text: chunk, parse_mode: 'Markdown' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && /parse/i.test(e.description ?? '')) {
        log({ event: 'markdown-fallback' });
        await api.sendMessage({ chat_id: target, text: chunk });
      } else {
        throw e;
      }
    }
  }
  return { chatId: target, parts: chunks.length };
}
