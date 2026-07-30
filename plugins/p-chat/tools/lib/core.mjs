import { ConfigError, requireAllowlist } from './config.mjs';
import { classifyUpdate, pendingFreeTexts } from './queue.mjs';
import { readOffset, writeOffset, appendLocalLog as realAppendLocalLog } from './state.mjs';
import { runShell as realRunShell } from './exec.mjs';
import { sendText as realSendText } from './send.mjs';

// The p-shed guard body. Peek the queue (getUpdates with offset = confirmed+1 is a
// peek — Telegram re-serves until a later offset confirms), serve scripted commands,
// decide launch:
//   { result: 'work' }  -> a free-text question is pending (CLI exits 0 -> Claude runs)
//   { result: 'quiet' } -> nothing to do (CLI exits 75)
// Throws ConfigError/ApiError when broken (CLI exits 2 -> p-shed guard-error -> breaker).
//
// Updates are processed STRICTLY IN QUEUE ORDER with a single cursor, and the scan
// STOPS at the first free-text message from an allowed chat: Telegram confirms
// everything below the offset, so the cursor must never jump an unanswered question.
// The cursor is persisted after EACH processed update — a crash mid-scan never
// re-answers what was already confirmed (commands are at-least-once: answered, THEN
// confirmed).
export async function guardScan({ root, cfg, api, now = Date.now, deps = {} }) {
  const d = { runShell: realRunShell, sendText: realSendText, appendLocalLog: realAppendLocalLog, ...deps };
  requireAllowlist(cfg);
  const offset = readOffset(root);
  const updates = await api.getUpdates(offset.confirmed + 1);
  let confirmed = offset.confirmed;
  let work = false;
  for (const u of updates) {
    const c = classifyUpdate(u, cfg);
    if (c.kind === 'free') { work = true; break; } // stays unconfirmed for the responder
    if (c.kind === 'command') {
      // Scripted answers work even when Claude is usage-limited or broken — that is
      // the whole point of handling them here, without a launch.
      const r = await d.runShell(cfg.commands[c.command], { cwd: root, timeoutSec: cfg.commandTimeoutSec });
      await d.sendText({ api, cfg, chatId: c.chatId, text: commandReply(c.command, r), log: (rec) => d.appendLocalLog(root, { ts: now(), ...rec }) });
      d.appendLocalLog(root, { ts: now(), event: 'command', command: c.command, exit: r.exit, timedOut: r.timedOut });
    } else {
      d.appendLocalLog(root, { ts: now(), event: 'skipped-update', updateId: c.updateId, chatId: c.chatId ?? null });
    }
    confirmed = c.updateId;
    writeOffset(root, { confirmed, lastPollAt: now() });
  }
  writeOffset(root, { confirmed, lastPollAt: now() });
  return { result: work ? 'work' : 'quiet', confirmed };
}

// Command reply: output tail, capped well under one Telegram message, with an
// explicit error marker so a failing status tool is visible from the phone.
function commandReply(command, r) {
  const text = [r.out, r.err].filter(Boolean).join('\n').trim();
  const capped = text.length > 3500 ? `…${text.slice(-3500)}` : text;
  if (r.timedOut) return `${command}: timed out`;
  if (r.exit !== 0) return `${command}: exit ${r.exit}${capped ? `\n${capped}` : ''}`;
  return capped || `${command}: ok (no output)`;
}

// The responder's read view (see queue.mjs for the stop-before-first-command rule).
// Never moves the confirmed cursor — only `ack` does that.
export async function listPending({ root, cfg, api, now = Date.now }) {
  requireAllowlist(cfg);
  const offset = readOffset(root);
  const updates = await api.getUpdates(offset.confirmed + 1);
  writeOffset(root, { ...offset, lastPollAt: now() });
  return pendingFreeTexts(updates, cfg);
}

// init helper: getMe smoke test, chat-id discovery from the newest pending message
// (--chat-id optional), and cursor baseline to the newest update so stale history
// (Telegram holds ~24h) is never replayed.
export async function initDiscover({ api, chatId }) {
  const me = await api.getMe();
  const updates = await api.getUpdates();
  let confirmed = 0;
  for (const u of updates) confirmed = Math.max(confirmed, u.update_id);
  let discovered = chatId;
  if (discovered == null) {
    const withChat = updates.filter((u) => u.message?.chat?.id != null);
    if (withChat.length === 0) {
      throw new ConfigError('no --chat-id given and no pending updates — send the bot any message first, then re-run init');
    }
    discovered = withChat[withChat.length - 1].message.chat.id;
  }
  return { me, chatId: discovered, confirmed };
}
