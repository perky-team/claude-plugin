// Tokenize markdown into top-level blocks then parse inlines.
// Supports: # h1, ## h2, ### h3, paragraph, - / 1. lists (nested by indent), ``` code, > blockquote.
// Inlines: **bold**, *italic* / _italic_, `code`, [text](url).

export function markdownToAdf(md) {
  const lines = md.split(/\r?\n/);
  const blocks = parseBlocks(lines);
  return { type: 'doc', version: 1, content: blocks };
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^#{1,3} /.test(line)) {
      const level = line.match(/^(#{1,3}) /)[1].length;
      const text = line.replace(/^#{1,3} /, '');
      out.push({ type: 'heading', attrs: { level }, content: parseInline(text) });
      i++; continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i++; }
      if (i < lines.length) i++; // closing ```
      const attrs = lang ? { language: lang } : {};
      out.push({ type: 'codeBlock', attrs, content: [{ type: 'text', text: body.join('\n') }] });
      continue;
    }
    if (/^> /.test(line)) {
      const buf = [];
      while (i < lines.length && /^> /.test(lines[i])) { buf.push(lines[i].slice(2)); i++; }
      out.push({ type: 'blockquote', content: parseBlocks(buf) });
      continue;
    }
    if (/^\s*[-*] /.test(line) || /^\s*\d+\. /.test(line)) {
      const { node, next } = parseList(lines, i);
      out.push(node);
      i = next;
      continue;
    }
    // paragraph: collect non-blank lines
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,3} /.test(lines[i]) && !lines[i].startsWith('```') && !/^> /.test(lines[i]) && !/^\s*[-*] /.test(lines[i]) && !/^\s*\d+\. /.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push({ type: 'paragraph', content: parseInline(buf.join(' ')) });
  }
  return out;
}

function parseList(lines, start) {
  const firstIndent = lines[start].match(/^(\s*)/)[1].length;
  const ordered = /^\s*\d+\. /.test(lines[start]);
  const type = ordered ? 'orderedList' : 'bulletList';
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) break;
    const ind = line.match(/^(\s*)/)[1].length;
    if (ind < firstIndent) break;
    const isItem = (ordered ? /^\s*\d+\. / : /^\s*[-*] /).test(line) && ind === firstIndent;
    if (!isItem && ind === firstIndent) break;
    if (isItem) {
      const text = line.replace(/^\s*(?:\d+\.|[-*]) /, '');
      const content = [{ type: 'paragraph', content: parseInline(text) }];
      // nested list (lookahead)
      let j = i + 1;
      const nestedStart = j;
      while (j < lines.length && /^\s*[-*] /.test(lines[j]) && lines[j].match(/^(\s*)/)[1].length > firstIndent) j++;
      if (j > nestedStart) {
        const { node } = parseList(lines, nestedStart);
        content.push(node);
        i = j;
      } else { i++; }
      items.push({ type: 'listItem', content });
    } else { i++; }
  }
  return { node: { type, content: items }, next: i };
}

function parseInline(text) {
  // Tokenize: scan left-to-right for the next active token.
  const out = [];
  let i = 0;
  let buf = '';
  function flush() { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } }
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > 0) { flush(); out.push({ type: 'text', text: text.slice(i + 2, end), marks: [{ type: 'strong' }] }); i = end + 2; continue; }
    }
    if ((text[i] === '*' || text[i] === '_') && text[i + 1] !== text[i]) {
      const ch = text[i];
      const end = text.indexOf(ch, i + 1);
      if (end > 0) { flush(); out.push({ type: 'text', text: text.slice(i + 1, end), marks: [{ type: 'em' }] }); i = end + 1; continue; }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > 0) { flush(); out.push({ type: 'text', text: text.slice(i + 1, end), marks: [{ type: 'code' }] }); i = end + 1; continue; }
    }
    if (text[i] === '[') {
      const m = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (m) { flush(); out.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] }); i += m[0].length; continue; }
    }
    buf += text[i++];
  }
  flush();
  return out;
}

export function adfToMarkdown(doc) {
  if (!doc || !Array.isArray(doc.content)) return '';
  return doc.content.map(renderBlock).filter(s => s !== null).join('\n\n');
}

function renderBlock(node, depth = 0) {
  switch (node.type) {
    case 'heading': return '#'.repeat(node.attrs?.level ?? 1) + ' ' + renderInline(node.content ?? []);
    case 'paragraph': return renderInline(node.content ?? []);
    case 'bulletList': return renderList(node, '-', depth);
    case 'orderedList': return renderList(node, '1.', depth);
    case 'codeBlock': {
      const lang = node.attrs?.language ?? '';
      const body = (node.content ?? []).map(t => t.text ?? '').join('');
      return '```' + lang + '\n' + body + '\n```';
    }
    case 'blockquote': {
      const inner = (node.content ?? []).map(b => renderBlock(b, depth)).filter(s => s !== null).join('\n\n');
      return inner.split('\n').map(l => '> ' + l).join('\n');
    }
    default: return null;
  }
}

function renderList(node, marker, depth) {
  const lines = [];
  for (const item of node.content ?? []) {
    const para = (item.content ?? []).find(c => c.type === 'paragraph');
    const indent = '  '.repeat(depth);
    lines.push(indent + marker + ' ' + renderInline(para?.content ?? []));
    for (const c of item.content ?? []) {
      if (c.type === 'bulletList' || c.type === 'orderedList') {
        lines.push(renderList(c, c.type === 'bulletList' ? '-' : '1.', depth + 1));
      }
    }
  }
  return lines.join('\n');
}

function renderInline(nodes) {
  return nodes.map(n => {
    let t = n.text ?? '';
    for (const m of n.marks ?? []) {
      if (m.type === 'strong') t = `**${t}**`;
      else if (m.type === 'em') t = `*${t}*`;
      else if (m.type === 'code') t = '`' + t + '`';
      else if (m.type === 'link') t = `[${t}](${m.attrs.href})`;
    }
    return t;
  }).join('');
}
