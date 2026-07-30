// Pure queue logic. THE INJECTION BOUNDARY lives here: a message either EXACTLY
// equals a configured command key (after trim) or it is free text — message text is
// never interpolated into a shell line, never prefix-matched.

export function classifyUpdate(u, cfg) {
  const updateId = u.update_id;
  const msg = u.message;
  const text = typeof msg?.text === 'string' ? msg.text : null;
  const chatId = msg?.chat?.id;
  const allowed = Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.includes(chatId);
  if (text == null || !allowed) {
    // Non-text updates (stickers, photos, edits, service updates) and messages from
    // non-allowlisted chats: the caller logs them locally and the cursor advances
    // past — never a reply.
    return { updateId, kind: 'other', chatId };
  }
  const trimmed = text.trim();
  if (Object.prototype.hasOwnProperty.call(cfg.commands ?? {}, trimmed)) {
    return { updateId, kind: 'command', chatId, command: trimmed };
  }
  return { updateId, kind: 'free', chatId, text, date: msg.date };
}

// The responder's read view: the CONTIGUOUS PREFIX of free-text messages, stopping
// BEFORE the first scripted command. Stopping matters: the responder acks up to the
// last answered question and Telegram confirms everything below that offset — a
// /command inside the acked range would be confirmed UNEXECUTED. It runs on the
// next guard pass instead. 'other' updates are skipped (nothing to answer).
export function pendingFreeTexts(updates, cfg) {
  const out = [];
  for (const u of updates) {
    const c = classifyUpdate(u, cfg);
    if (c.kind === 'command') break;
    if (c.kind === 'free') out.push({ updateId: c.updateId, chatId: c.chatId, text: c.text, date: c.date });
  }
  return out;
}
