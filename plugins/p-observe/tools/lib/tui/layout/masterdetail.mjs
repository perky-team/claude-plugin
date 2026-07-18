import { fit } from '../ansi.mjs';

export function clampIdx(idx, len) {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(idx, len - 1));
}

export function renderMasterDetail({ items, selectedIdx, detailLines, width, height, color = false }) {
  const listW = Math.max(12, Math.floor(width * 0.4));
  const detailW = width - listW - 1;
  const sel = clampIdx(selectedIdx, items.length);
  // window the list around the selection so a long list still shows the cursor
  const start = Math.max(0, Math.min(sel - Math.floor(height / 2), Math.max(0, items.length - height)));
  const rows = [];
  for (let i = 0; i < height; i++) {
    const idx = start + i;
    let left = '';
    if (idx < items.length) {
      const marker = idx === sel ? '>' : ' ';
      const row = `${marker} ${items[idx]}`;
      left = color && idx === sel ? `\x1b[7m${fit(row, listW)}\x1b[0m` : fit(row, listW);
    } else {
      left = fit('', listW);
    }
    const right = fit(detailLines[i] ?? '', detailW);
    rows.push(left + '│' + right);
  }
  return rows;
}
