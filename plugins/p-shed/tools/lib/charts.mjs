// SVG for the one chart that needs real geometry. Pure: a string in, a string out.
//
// Only the daily chart is SVG. The cost-by-job bars on the page are plain <div>s with a
// percentage width — they need no geometry, they align with their label by construction,
// they reflow on a narrow screen where SVG text does not, and they keep every job name
// inside html.mjs, which is where escaping lives. A generator that drew job names would
// need its own copy of escapeHtml and would import it back from html.mjs, making the two
// modules circular.
//
// This module holds no colors. html.mjs owns the palette and passes it in, so light and
// dark are decided in exactly one place.

const PAD_T = 12;
const AXIS_H = 14;
const GAP = 2;      // surface gap between neighbouring bars — never a border on the bar
const RADIUS = 4;   // rounded data-end only; the baseline end stays square

// A vertical bar with a rounded top and a flat bottom, anchored on the baseline.
function barPath(x, y, w, h) {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z`;
}

const round = (n) => Math.round(n * 100) / 100;

export function barsByDay(byDay, { width, height, series, muted, grid }) {
  const days = Array.isArray(byDay) ? byDay : [];
  const max = days.reduce((m, d) => Math.max(m, d.costUsd ?? 0), 0);
  const baseY = height - AXIS_H;

  const frame =
    `<line x1="0" y1="${baseY}" x2="${width}" y2="${baseY}" stroke="${grid}" stroke-width="1"/>`;

  if (!days.length || max <= 0) {
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="daily cost, no runs yet">`
      + frame
      + `<text x="${width / 2}" y="${baseY / 2}" fill="${muted}" font-size="11" text-anchor="middle">no runs yet</text>`
      + `</svg>`;
  }

  const plotH = height - PAD_T - AXIS_H;
  const slot = width / days.length;
  const barW = Math.max(1, slot - GAP);
  const bars = [];
  const labels = [];

  days.forEach((d, i) => {
    const x = round(i * slot + GAP / 2);
    if (d.costUsd !== null && d.costUsd > 0) {
      const h = round((d.costUsd / max) * plotH);
      const y = round(baseY - h);
      bars.push(
        `<path class="bar" d="${barPath(x, y, round(barW), h)}" fill="${series}" data-x="${x}" data-w="${round(barW)}" data-h="${h}"/>`,
      );
    }
    // Only the ends are labelled. A date under every bar is unreadable at phone width,
    // and the table view carries every value anyway.
    if (i === 0 || i === days.length - 1) {
      labels.push(
        `<text x="${round(x + barW / 2)}" y="${height - 3}" fill="${muted}" font-size="10" text-anchor="${i === 0 ? 'start' : 'end'}">${d.date.slice(5)}</text>`,
      );
    }
  });

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="daily cost over the window">`
    + frame + bars.join('') + labels.join('') + `</svg>`;
}
