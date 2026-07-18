export const ENTER_ALT = '\x1b[?1049h';
export const EXIT_ALT = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const CLEAR = '\x1b[2J';
export const HOME = '\x1b[H';
export const DISABLE_WRAP = '\x1b[?7l';
export const ENABLE_WRAP = '\x1b[?7h';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleWidth(str) {
  return str.replace(ANSI_RE, '').length;
}

// Pad (right) or truncate `str` to exactly `width` visible cells. Color escapes
// are copied "for free" (don't count toward width); a truncation appends \x1b[0m
// so a cut mid-color never bleeds into the rest of the screen.
export function fit(str, width) {
  if (width <= 0) return '';
  let out = '';
  let seen = 0;
  let colored = false;
  for (let i = 0; i < str.length; ) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; colored = true; i += m[0].length; continue; }
    }
    if (seen >= width) { return out + (colored ? '\x1b[0m' : ''); }
    out += str[i]; seen++; i++;
  }
  if (seen < width) out += ' '.repeat(width - seen);
  return out;
}
