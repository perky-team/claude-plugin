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

export function barsByDay(byDay, opts) {
  const { width, height, series, muted, grid } = opts;
  const days = Array.isArray(byDay) ? byDay : [];
  const baseY = height - AXIS_H;

  const frame =
    `<line x1="0" y1="${baseY}" x2="${width}" y2="${baseY}" stroke="${grid}" stroke-width="1"/>`;

  // Shared by both empty states below. The label is both the visible text and,
  // via the aria-label, the accessible name — so the two never say different things.
  const emptyState = (label) =>
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="daily cost, ${label}">`
    + frame
    + `<text x="${width / 2}" y="${baseY / 2}" fill="${muted}" font-size="11" text-anchor="middle">${label}</text>`
    + `</svg>`;

  // costUsd is null when a day was never measured, and 0 when it was measured and
  // cost nothing — different facts. runs is what tells them apart: a day can have
  // real runs and a real zero cost, and that must not read as "no runs yet".
  const hasAnyRun = days.some((d) => (d.runs ?? 0) > 0);
  if (!days.length || !hasAnyRun) {
    return emptyState('no runs yet');
  }

  // Non-finite costUsd is ignored rather than trusted: today's caller filters it
  // out upstream, but this module must never throw or emit malformed markup no
  // matter what DAY DATA it is handed, so one bad value must not poison the whole
  // chart. That promise covers byDay entries only — a missing or malformed opts
  // is a programming error at the call site, not day data, and must throw (see
  // the destructure above, which has no default).
  const max = days.reduce(
    (m, d) => (Number.isFinite(d.costUsd) ? Math.max(m, d.costUsd) : m),
    0,
  );
  if (max <= 0) {
    return emptyState('no cost recorded');
  }

  const plotH = Math.max(0, height - PAD_T - AXIS_H);
  const slot = width / days.length;
  const barW = Math.max(1, slot - GAP);
  const bars = [];
  const labels = [];

  days.forEach((d, i) => {
    const x = round(i * slot + GAP / 2);
    if (Number.isFinite(d.costUsd) && d.costUsd > 0) {
      const h = round((d.costUsd / max) * plotH);
      const y = round(baseY - h);
      bars.push(
        `<path class="bar" d="${barPath(x, y, round(barW), h)}" fill="${series}" data-x="${x}" data-y="${y}" data-w="${round(barW)}" data-h="${h}"/>`,
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
