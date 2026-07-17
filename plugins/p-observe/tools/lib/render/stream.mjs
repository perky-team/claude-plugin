const GLYPH = { ok: '✓', info: '•', warn: '⚠', error: '✗' };
const COLOR = { ok: 32, info: 36, warn: 33, error: 31 };

function hhmmss(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatLine(event, { color = false } = {}) {
  const glyph = GLYPH[event.severity] ?? '•';
  const plugin = event.plugin.padEnd(8);
  const body = `${hhmmss(event.ts)}  ${plugin} ${glyph} ${event.entity !== '-' ? event.entity + '  ' : ''}${event.summary}`;
  if (!color) return body;
  return `[${COLOR[event.severity] ?? 36}m${body}[0m`;
}
