import { barsByDay } from './charts.mjs';

// The report page. Pure: everything it needs arrives as arguments, and it returns one
// self-contained HTML document.
//
// Two rules the page cannot break:
//   - No JavaScript and nothing fetched from the network. It is opened on a phone, often
//     on a bad connection, and a half-loaded dashboard is worse than a plain one. That is
//     why the charts are server-rendered and the expanders are native <details>.
//   - Every value that came from outside is escaped. Job ids, pause reasons, breaker
//     reasons and the raw output tail all reach this page from files a job can write.

const PALETTE = {
  light: { surface: '#fcfcfb', plane: '#f9f9f7', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', series: '#2a78d6' },
  dark: { surface: '#1a1a19', plane: '#0d0d0d', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', series: '#3987e5' },
};

// Fixed status tokens, never themed. They are used ONE AT A TIME, each next to an icon
// and a text label — never as adjacent fills. Four of them side by side in a stacked bar
// fails the palette checks outright: critical against good measures dE 4.1 under
// deuteranopia, and serious against warning 13.6 for normal vision, below the floor of
// 15. That is why run outcomes on this page are four stat tiles and not one proportion
// bar. On the light surface warning (1.79) and serious (2.57) sit below 3:1 contrast, so
// their labels are what carry the meaning, not the colour.
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

export function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const money = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');

// A job is in exactly one of these states, and the order is the precedence.
//
// Status colours are literal hex because they are mode-invariant by design — the same
// four steps clear their contrast floor on both surfaces. The two non-status colours are
// `var(...)` instead: the series blue and the muted grey have a different step per mode,
// and a literal here would freeze the light step onto the dark surface.
function jobState(j) {
  if (j.breakerTripped) return { key: 'breaker', label: 'breaker', icon: '⛔', color: STATUS.critical, problem: true };
  if (j.paused && j.pauseOrigin === 'self') return { key: 'self-pause', label: 'paused itself', icon: '⏸', color: STATUS.serious, problem: true };
  if (j.paused) return { key: 'held', label: `paused (${j.pauseOrigin ?? 'operator'})`, icon: '⏸', color: 'var(--muted)', problem: false };
  if (j.retryNotBefore != null) return { key: 'retry', label: 'retry pending', icon: '⏳', color: STATUS.warning, problem: true };
  if (j.running) return { key: 'running', label: 'running', icon: '●', color: 'var(--series)', problem: false };
  if (j.enabled === false) return { key: 'off', label: 'disabled', icon: '○', color: 'var(--muted)', problem: false };
  return { key: 'ok', label: 'ok', icon: '○', color: STATUS.good, problem: false };
}

function nextLabel(entry) {
  if (!entry) return '—';
  if (entry.due) return 'due';
  return entry.at == null ? '—' : hhmm(entry.at);
}

function css() {
  const l = PALETTE.light, d = PALETTE.dark;
  const vars = (p) => `--surface:${p.surface};--plane:${p.plane};--ink:${p.ink};--ink2:${p.ink2};--muted:${p.muted};--grid:${p.grid};--series:${p.series};`;
  return `
:root{color-scheme:light;${vars(l)}}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;${vars(d)}}}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:var(--plane);color:var(--ink);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));max-width:1200px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:12px}
h1{font-size:15px;margin:0 0 2px}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.sub{color:var(--ink2);font-size:12px}
.hero{font-size:28px;margin:2px 0 8px}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline;padding:3px 0}
.bar-track{height:8px;background:var(--grid);border-radius:0 4px 4px 0;margin-top:3px}
.bar-fill{height:8px;background:var(--series);border-radius:0 4px 4px 0}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center}
.tile-n{font-size:20px}
.tile-l{font-size:11px;color:var(--ink2)}
table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
td{padding:2px 0;border-top:1px solid var(--grid)}
td+td{text-align:right}
pre{white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--ink2);margin:6px 0 0}
details{margin-top:8px}
summary{cursor:pointer;color:var(--muted);font-size:12px}
.reason{color:var(--ink2);font-size:12px;margin-top:2px}`;
}

// The state key rides along as a class so tests can assert WHICH badge was chosen —
// self-pause and operator-pause differ only in colour and wording otherwise, and that
// distinction is the point.
function badge(state) {
  return `<span class="badge badge-${state.key}" style="color:${state.color}"><span class="dot" style="background:${state.color}"></span>${state.icon} ${escapeHtml(state.label)}</span>`;
}

function problemCard(j, state, next, agg) {
  const cost = agg.byJob[j.id]?.costUsd;
  const detail = [
    j.breakerTripped && j.consecutiveFailures ? `${j.consecutiveFailures} fails in a row` : '',
    j.lastRun ? `last ${hhmm(j.lastRun)}${j.lastExit == null ? '' : ` · exit ${escapeHtml(j.lastExit)}`}` : 'never run',
    j.lastSkipReason ? escapeHtml(j.lastSkipReason) : '',
    `next ${nextLabel(next[j.id])}`,
    cost != null ? money(cost) : '',
  ].filter(Boolean).join(' · ');
  const reason = j.pauseReason ?? j.breakerReason;
  return `<div class="card">
<div class="row"><strong>${escapeHtml(j.id)}</strong>${badge(state)}</div>
<div class="sub">${detail}</div>
${reason ? `<div class="reason">“${escapeHtml(reason)}”</div>` : ''}
</div>`;
}

function costCard(agg) {
  const max = Object.values(agg.byJob).reduce((m, j) => Math.max(m, j.costUsd ?? 0), 0);
  const rows = Object.entries(agg.byJob)
    .filter(([, j]) => j.costUsd != null)
    .sort((a, b) => b[1].costUsd - a[1].costUsd);
  const top = rows.slice(0, 8);
  const rest = rows.slice(8).reduce((s, [, j]) => s + j.costUsd, 0);
  if (rest > 0) top.push(['other', { costUsd: rest }]);

  const bars = top.map(([id, j]) => `<div>
<div class="row"><span>${escapeHtml(id)}</span><span>${money(j.costUsd)}</span></div>
<div class="bar-track"><div class="bar-fill" style="width:${max > 0 ? Math.round((j.costUsd / max) * 100) : 0}%"></div></div>
</div>`).join('');

  const table = agg.byDay.map((d) =>
    `<tr><td>${escapeHtml(d.date)}</td><td>${d.runs}</td><td>${money(d.costUsd)}</td></tr>`).join('');

  return `<div class="card">
<h2>Cost · ${agg.windowDays} days</h2>
<div class="hero">${money(agg.totals.costUsd)}</div>
${barsByDay(agg.byDay, { width: 320, height: 96, series: PALETTE.light.series, muted: PALETTE.light.muted, grid: PALETTE.light.grid })}
${bars ? `<h2 style="margin-top:12px">Where it goes</h2>${bars}` : ''}
<details class="table-view"><summary>table</summary>
<table><tr><td>day</td><td>runs</td><td>cost</td></tr>${table}</table></details>
</div>`;
}

function runsCard(agg) {
  const o = agg.totals.outcomes;
  const tile = (n, label, color) =>
    `<div><div class="tile-n" style="color:${color}">${n}</div><div class="tile-l">${label}</div></div>`;
  return `<div class="card">
<h2>Runs · ${agg.windowDays} days</h2>
<div class="hero">${agg.totals.runs}</div>
<div class="tiles">
${tile(o.success, 'ok', STATUS.good)}
${tile(o.failure, 'failed', STATUS.critical)}
${tile(o.skipped, 'skipped', STATUS.warning)}
${tile(o.guardError, 'guard err', STATUS.serious)}
</div>
<div class="sub" style="margin-top:8px">usage-limit ${agg.totals.skips.usageLimit} · overload ${agg.totals.skips.apiOverload}</div>
</div>`;
}

function jobsCard(jobs, agg, next) {
  const rows = jobs.map((j) => {
    const state = jobState(j);
    const cost = agg.byJob[j.id]?.costUsd;
    return `<tr><td>${escapeHtml(j.id)} ${badge(state)}</td><td>${nextLabel(next[j.id])}</td><td>${money(cost)}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Jobs</h2><table><tr><td>job</td><td>next</td><td>cost</td></tr>${rows}</table></div>`;
}

function recentCard(agg) {
  const rows = agg.recent.map((e) =>
    `<tr><td>${hhmm(e.ts)} ${escapeHtml(e.job ?? '—')}</td><td>${escapeHtml(e.detail)}</td></tr>`).join('');
  return `<div class="card"><h2>Recent</h2><table>${rows || '<tr><td>nothing yet</td></tr>'}</table></div>`;
}

export function renderHtml(status, agg, next, now) {
  const states = status.jobs.map((j) => ({ j, state: jobState(j) }));
  const problems = states.filter((s) => s.state.problem);
  const healthy = states.filter((s) => !s.state.problem);
  const head = `${problems.length} problem${problems.length === 1 ? '' : 's'} · ${money(agg.totals.costUsd)} / ${agg.windowDays}d`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>p-shed · ${escapeHtml(status.task)}</title>
<style>${css()}</style></head>
<body>
<div class="grid">
<div class="card">
<h1>p-shed · ${escapeHtml(status.task)}</h1>
<div class="sub">${head}</div>
<div class="sub">generated ${hhmm(now)} · cron ${status.installed === null ? 'unknown' : status.installed ? 'installed' : 'NOT installed'}${status.profile?.name ? ` · profile ${escapeHtml(status.profile.name)}` : ''}${status.paused ? ' · SCHEDULER PAUSED' : ''}</div>
</div>
${problems.map(({ j, state }) => problemCard(j, state, next, agg)).join('')}
${costCard(agg)}
${runsCard(agg)}
${jobsCard(healthy.map((s) => s.j), agg, next)}
${recentCard(agg)}
<div class="card sub">window ${agg.windowDays} days · ${agg.skippedLines} unreadable log line(s)</div>
</div>
</body></html>`;
}
