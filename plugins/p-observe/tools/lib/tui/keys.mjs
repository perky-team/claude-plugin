// Decode a raw stdin chunk into semantic key tokens. Arrow-key escape
// sequences arrive as one chunk (\x1b[A); a lone \x1b (final byte of the
// chunk) is Esc; any other escape sequence (Home/End/PageUp/Delete/F-keys,
// CSI or SS3) is swallowed so it can never be mistaken for Esc.
export function decodeKeys(str) {
  const out = [];
  for (let i = 0; i < str.length; ) {
    const c = str[i];
    if (c === '\x1b') {
      const seq = str.slice(i, i + 3);
      if (seq === '\x1b[A') { out.push('up'); i += 3; continue; }
      if (seq === '\x1b[B') { out.push('down'); i += 3; continue; }
      if (seq === '\x1b[C' || seq === '\x1b[D') { i += 3; continue; } // ignore left/right
      if (i === str.length - 1) { out.push('esc'); i += 1; continue; } // lone Esc
      // Unrecognized escape sequence: swallow it, emit nothing.
      i += 1;
      if (str[i] === '[' || str[i] === 'O') {
        i += 1;
        while (i < str.length && !(str[i] >= '@' && str[i] <= '~')) i += 1; // skip params/intermediates
        if (i < str.length) i += 1; // consume the final byte
      }
      continue;
    }
    if (c === '\t') { out.push('tab'); i++; continue; }
    if (c === '\r' || c === '\n') { out.push('enter'); i++; continue; }
    if (c === '\x7f' || c === '\b') { out.push('backspace'); i++; continue; }
    if (c === '\x03') { out.push('ctrl-c'); i++; continue; }
    if (c >= '1' && c <= '9') { out.push('digit:' + c); i++; continue; }
    if (c === 'j' || c === 'k' || c === 'f' || c === 'q' || c === '/') { out.push(c); i++; continue; }
    if (c >= ' ' && c <= '~') { out.push('char:' + c); i++; continue; }
    i++; // drop other control bytes
  }
  return out;
}
