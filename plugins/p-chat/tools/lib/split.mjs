// Telegram caps message text at 4096 characters. Split long text into chunks,
// preferring newline boundaries, never splitting a UTF-16 surrogate pair.
export const TELEGRAM_MAX = 4096;

export function splitMessage(text, max = TELEGRAM_MAX) {
  const s = String(text);
  if (s.length === 0) return [];
  if (s.length <= max) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max; // no usable newline -> hard cut
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1; // never orphan a surrogate pair
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (rest.startsWith('\n')) rest = rest.slice(1); // the boundary newline is consumed, not lost content
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
