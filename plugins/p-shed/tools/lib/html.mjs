import { barsByDay } from './charts.mjs';
import { resolveGroup } from './concurrency.mjs';

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

const pad2 = (n) => String(n).padStart(2, '0');

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const dateStr = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

function sameLocalDay(aMs, bMs) {
  const a = new Date(aMs), b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// A timestamp shown next to `now`. Today keeps a bare time — the common case, and the
// column is narrow on a phone — everything else also carries its date, so a next-run
// months away, or a log row a few days old in the 7-day window, cannot be misread as
// "today" or "just now". See A3/A4/C7 in the review that added this.
function whenLabel(ms, now) {
  return sameLocalDay(ms, now) ? hhmm(ms) : `${dateStr(ms)} ${hhmm(ms)}`;
}

const money = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');

// Large token/turn counts are easier to scan on a phone with separators — built into
// the platform, so this needs no vendored formatting library.
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

// "14m50s" / "46s" — the same shape a run's duration is shown in everywhere else on
// this page (see report.mjs's `secs` helper, which this deliberately mirrors instead
// of reusing: that one only ever wraps a value in parentheses for the recent list).
function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

const PROMPT_SUMMARY_MAX = 80;

// Collapse a (possibly multi-line) prompt to one line, cut to `max` characters. The
// untouched original always sits behind the <details> this feeds, so nothing here
// needs to be exact — only short enough to fit one line on a 640px-wide phone card.
function trimOneLine(text, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// The job's own maxConsecutiveFailures, falling back to defaults.yml's, then p-shed's
// built-in default — the exact precedence tick.mjs uses to decide when the breaker
// trips, so this page can never warn about a threshold the scheduler does not use.
function effectiveMaxFailures(jobMeta, defaults) {
  return jobMeta?.maxConsecutiveFailures ?? defaults?.maxConsecutiveFailures ?? 3;
}

// The job's own model, falling back to defaults.yml's — the exact precedence
// launch.mjs's buildArgs uses to build the real `claude -p --model …` call. A jobs.yml
// that sets `model:` once in `defaults` (the ordinary way to configure a loop) used to
// show no model on any post, since this used to read `jobMeta.model` directly — a bare
// cron string that reads like a bug, not like a job inheriting its model normally.
function effectiveModel(jobMeta, defaults) {
  return jobMeta?.model ?? defaults?.model ?? null;
}

// The job's own timeout, falling back to defaults.yml's, then p-shed's built-in 900s —
// the exact precedence launch.mjs's runJob uses to decide when a run gets killed. Used
// by the "slowest runs" card so a run is never shown against a timeout the scheduler
// would not actually enforce.
function effectiveTimeoutSec(jobMeta, defaults) {
  return jobMeta?.timeoutSec ?? defaults?.timeoutSec ?? 900;
}

// True for a job whose failures are building but whose breaker has not tripped yet —
// invisible everywhere else on the page (jobState reads `ok`/`held`/`running` for it,
// same as a job with a clean record). `maxFailures <= 0` disables the breaker for that
// job entirely (see tick.mjs), so an ever-climbing count there is not a warning.
function isAccumulating(j, jobMeta, defaults) {
  return !j.breakerTripped && j.consecutiveFailures > 0 && effectiveMaxFailures(jobMeta, defaults) > 0;
}

// A job is in exactly one of these states, and the order is the precedence.
//
// Status colours are literal hex because they are mode-invariant by design — the same
// four steps clear their contrast floor on both surfaces. The two non-status colours are
// `var(...)` instead: the series blue is a different step per mode, and a literal here
// would freeze the light step onto the dark surface. The muted grey is `var(...)` too,
// but only for consistency of style — its value is deliberately the SAME in both modes.
// `enabled === false` is checked before `retryNotBefore` on purpose, matching
// report.mjs's `computeNext` (which treats them the same way — see A1 in the review
// that fixed this). A disabled job keeps whatever `retryNotBefore` its last skip wrote,
// forever, since nothing clears it once the job stops running — without this order a
// switched-off job reads as a permanent "retry pending" problem.
function jobState(j) {
  if (j.breakerTripped) return { key: 'breaker', label: 'breaker', icon: '⛔', color: STATUS.critical, problem: true };
  if (j.paused && j.pauseOrigin === 'self') return { key: 'self-pause', label: 'paused itself', icon: '⏸', color: STATUS.serious, problem: true };
  if (j.paused) return { key: 'held', label: `paused (${j.pauseOrigin ?? 'operator'})`, icon: '⏸', color: 'var(--muted)', problem: false };
  if (j.enabled === false) return { key: 'off', label: 'disabled', icon: '○', color: 'var(--muted)', problem: false };
  if (j.retryNotBefore != null) return { key: 'retry', label: 'retry pending', icon: '⏳', color: STATUS.warning, problem: true };
  if (j.running) return { key: 'running', label: 'running', icon: '●', color: 'var(--series)', problem: false };
  return { key: 'ok', label: 'ok', icon: '○', color: STATUS.good, problem: false };
}

// A profile with nothing wrong shows only its name (or is absent, when collectStatus
// omits the field entirely — see status.mjs). `problem` and `warning` must show even
// when `name` is null: that is the case an operator most needs to catch, because the
// scheduler is quietly ticking at its default pace instead of the one configured.
// Wording matches lib/profile.mjs's own comment on what each field means:
//   problem 'unknown-name'   the name resolved but the table has no such entry, so
//                            NO overrides are applied.
//   warning 'file-missing'   the configured profile file could not be read at all.
//   warning 'file-unreadable' the file exists but reading it failed.
//
// Rendered inside the "Scheduler health" card, not the header — printing it twice on
// the same page said nothing more than printing it once.
function profileNote(profile) {
  if (!profile) return '';
  const parts = [`profile ${profile.name ? escapeHtml(profile.name) : '—'}`];
  if (profile.problem === 'unknown-name') {
    parts.push(badge({ key: 'profile-problem', label: 'unknown profile name, no overrides applied', icon: '⛔', color: STATUS.critical }));
  }
  if (profile.warning === 'file-missing') {
    parts.push(badge({ key: 'profile-warning', label: 'profile file missing', icon: '⚠', color: STATUS.warning }));
  } else if (profile.warning === 'file-unreadable') {
    parts.push(badge({ key: 'profile-warning', label: 'profile file unreadable', icon: '⚠', color: STATUS.warning }));
  }
  return parts.join(' ');
}

function nextLabel(entry, now) {
  if (!entry) return '—';
  if (entry.due) return 'due';
  return entry.at == null ? '—' : whenLabel(entry.at, now);
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
.feed{display:flex;flex-direction:column;gap:12px;max-width:640px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:12px}
h1{font-size:15px;margin:0 0 2px}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.sub{color:var(--ink2);font-size:12px;margin-top:2px}
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
.reason{color:var(--ink2);font-size:12px;margin-top:2px;word-break:break-word}`;
}

// The state key rides along as a class so tests can assert WHICH badge was chosen —
// self-pause and operator-pause differ only in colour and wording otherwise, and that
// distinction is the point.
//
// The colour lives on the dot and the icon only — never on the label text. On the light
// surface, `warning` (1.79:1) and `serious` (2.58:1) sit below 3:1 contrast, so a
// coloured label can be close to invisible in daylight. The label stays in normal ink so
// it is always readable; the dot and icon still carry which colour means what (see A5).
function badge(state) {
  return `<span class="badge badge-${state.key}"><span class="dot" style="background:${state.color}"></span><span style="color:${state.color}">${state.icon}</span> ${escapeHtml(state.label)}</span>`;
}

// One post per job, whatever its state — the feed the owner asked for. Before this, a
// broken job got a card with its reason and every healthy job was one row in a shared
// table: two shapes on one page. Now every job gets the same skeleton, so reading the
// feed does not mean switching what kind of thing you are looking at; only the lines
// that have something to say are printed (see each `if` below).
//
// `jobMeta` is this job's entry in the EFFECTIVE jobs array (profile overrides already
// applied — see effectiveJobs in lib/profile.mjs), looked up by id in renderHtml and
// passed in here. It is undefined for a job in status.jobs that no longer has a match
// there (e.g. removed from jobs.yml while its state file is still on disk) — the post
// still renders in that case, just without the schedule/model/group line, since that
// line is the only thing this function reads from `jobMeta`.
function jobPost(j, state, jobMeta, defaults, agg, next, now) {
  const jobAgg = agg.byJob[j.id];

  // The trouble line. Only a PROBLEM gets one: a healthy job — including an operator or
  // deploy pause, both deliberate and neither counted as a problem — shows the same
  // skeleton minus this line, so a held job never reads as broken. `fails` rides along
  // on a breaker trip only, since that is the one state with a meaningful count to add.
  const reason = j.pauseReason ?? j.breakerReason;
  const fails = state.problem && j.breakerTripped && j.consecutiveFailures
    ? ` (${escapeHtml(j.consecutiveFailures)} fails in a row)` : '';
  const trouble = state.problem && reason ? `<div class="reason">“${escapeHtml(reason)}${fails}”</div>` : '';

  // A job whose failures are building but whose breaker has not tripped yet looks
  // exactly like a healthy job everywhere else on the page — `trouble` above only
  // fires once the breaker is already tripped. This is the line that closes that gap.
  // The colour rule (dot only, label in plain ink) is the same one badge() and the
  // outcome tiles follow.
  const failureLine = isAccumulating(j, jobMeta, defaults)
    ? `<div class="sub"><span class="dot" style="background:${STATUS.warning}"></span> ${j.consecutiveFailures} of ${effectiveMaxFailures(jobMeta, defaults)} failures</div>`
    : '';

  // When it runs, when it last ran — always shown, problem or not. `lastSkipReason`
  // (usage-limit / api-overload) rides along on the "last" side rather than getting its
  // own line: it is a property of the last attempt, same as the exit code next to it.
  const last = j.lastRun == null
    ? 'never run'
    : [
        `last ${whenLabel(j.lastRun, now)}`,
        j.lastExit != null ? `exit ${escapeHtml(j.lastExit)}` : '',
        j.lastSkipReason ? escapeHtml(j.lastSkipReason) : '',
      ].filter(Boolean).join(' ');

  // Schedule is the raw cron string, never a phrased-out "every 3h": a wrong human
  // phrasing would be a silent lie about when the job actually runs, while the cron
  // field is already the checkable source everywhere else on this page. The model and
  // the group both come through the same job-then-defaults resolution the scheduler
  // itself uses (effectiveModel / resolveGroup), not read off the job's own entry
  // directly — a job that sets neither on itself still shows what will actually run.
  const metaParts = jobMeta ? [
    jobMeta.schedule ? escapeHtml(jobMeta.schedule) : '',
    (() => {
      const model = effectiveModel(jobMeta, defaults);
      return model ? escapeHtml(model) : '';
    })(),
    (() => {
      const group = resolveGroup(jobMeta, defaults);
      return group ? `group ${escapeHtml(group)}` : '';
    })(),
  ].filter(Boolean) : [];

  // A job pointed at the wrong folder is a common, otherwise invisible mistake — shown
  // whenever the job sets one, same escaping as every other value a job file can write.
  const cwd = jobMeta?.cwd ? `<div class="sub">cwd ${escapeHtml(jobMeta.cwd)}</div>` : '';

  // What the job did and cost in the report window — omitted entirely for a job with
  // no runs there, rather than printing "0 runs" for every job that simply was not due.
  // Only the outcome counts that are actually non-zero print: a healthy job showing
  // "0 failed · 0 skipped" next to every other job would bury the ones that matter.
  const runs = jobAgg?.runs ?? 0;
  const cost = jobAgg?.costUsd;
  const o = jobAgg?.outcomes;
  const statsLine = runs > 0
    ? [
        `${runs} run${runs === 1 ? '' : 's'}`,
        o?.failure ? `${o.failure} failed` : '',
        o?.skipped ? `${o.skipped} skipped` : '',
        o?.guardError ? `${o.guardError} guard err` : '',
        cost != null ? money(cost) : '',
      ].filter(Boolean).join(' · ')
    : '';

  // Guard freshness, same wording as status --human's table, shown for any job that has
  // ever recorded one — a guardless job has no `lastGuard` and prints nothing here.
  const guard = j.lastGuard
    ? `guard ${escapeHtml(j.lastGuard.outcome)} ${Math.max(0, Math.round((now - j.lastGuard.at) / 1000))}s ago${j.lastGuard.reason ? ` (${escapeHtml(j.lastGuard.reason)})` : ''}`
    : '';

  // The tail of the most recent non-success run, straight from the log — text a job
  // itself wrote, so it is escaped exactly like every other outside value. `<details>`
  // keeps it out of the way until an operator asks for it: it can run to ~2 KB. Shown on
  // ANY job, not only a currently-broken one: the breaker can be reset while the
  // aggregate window still remembers the run that tripped it.
  //
  // A self-pause usually follows a run that exited 0 (that is the whole reason the
  // self-pause marker exists), so the tail shown here can be from an OLDER failed run,
  // not the run that caused the pause. Dating the summary stops an operator reading a
  // stale tail as the cause (see C2).
  const rawTail = jobAgg?.lastRaw;
  const rawTailTs = jobAgg?.lastRawTs;

  // Nothing on the page otherwise says what a job is FOR. One trimmed line as the
  // summary, the untouched prompt behind it — `<details>` rather than a second `<pre>`
  // inline, so a long multi-step prompt does not push every card below it off screen.
  const promptBlock = jobMeta?.prompt
    ? `<details><summary>${escapeHtml(trimOneLine(jobMeta.prompt, PROMPT_SUMMARY_MAX))}</summary><pre>${escapeHtml(jobMeta.prompt)}</pre></details>`
    : '';

  return `<div class="card">
<div class="row"><strong>${escapeHtml(j.id)}</strong>${badge(state)}</div>
${trouble}
${failureLine}
<div class="sub">next ${nextLabel(next[j.id], now)} · ${last}</div>
${metaParts.length ? `<div class="sub">${metaParts.join(' · ')}</div>` : ''}
${cwd}
${statsLine ? `<div class="sub">${agg.windowDays}d: ${statsLine}</div>` : ''}
${guard ? `<div class="sub">${guard}</div>` : ''}
${promptBlock}
${rawTail ? `<details><summary>show output (${whenLabel(rawTailTs, now)})</summary><pre>${escapeHtml(rawTail)}</pre></details>` : ''}
</div>`;
}

function costCard(agg) {
  const rows = Object.entries(agg.byJob)
    .filter(([, j]) => j.costUsd != null)
    .sort((a, b) => b[1].costUsd - a[1].costUsd);
  const top = rows.slice(0, 8);
  const rest = rows.slice(8).reduce((s, [, j]) => s + j.costUsd, 0);
  if (rest > 0) top.push(['other', { costUsd: rest }]);

  // `max` is taken over the rows actually SHOWN, after the fold — including `other`.
  // Taking it over individual jobs only (before the fold) let a summed `other` row
  // exceed the max and paint past 100% of its track: twelve $1 jobs gave max=$1 and
  // other=$4, a bar at width:400% with nothing to clip it (see A2). `Math.min(100, …)`
  // is the last-resort clamp; folding `max` in afterwards is what keeps the bars
  // meaningful relative to each other, not just non-overflowing.
  const max = top.reduce((m, [, j]) => Math.max(m, j.costUsd ?? 0), 0);

  const bars = top.map(([id, j]) => `<div>
<div class="row"><span>${escapeHtml(id)}</span><span>${money(j.costUsd)}</span></div>
<div class="bar-track"><div class="bar-fill" style="width:${max > 0 ? Math.min(100, Math.round((j.costUsd / max) * 100)) : 0}%"></div></div>
</div>`).join('');

  const table = agg.byDay.map((d) =>
    `<tr><td>${escapeHtml(d.date)}</td><td>${d.runs}</td><td>${money(d.costUsd)}</td></tr>`).join('');

  return `<div class="card">
<h2>Cost · ${agg.windowDays} days</h2>
<div class="hero">${money(agg.totals.costUsd)}</div>
${barsByDay(agg.byDay, { width: 320, height: 96, series: 'var(--series)', muted: 'var(--muted)', grid: 'var(--grid)' })}
${bars ? `<h2 style="margin-top:12px">Where it goes</h2>${bars}` : ''}
<details class="table-view"><summary>table</summary>
<table><tr><td>day</td><td>runs</td><td>cost</td></tr>${table}</table></details>
</div>`;
}

function runsCard(agg) {
  const o = agg.totals.outcomes;
  // The number is the thing an operator came for, so it stays in normal ink — the
  // status colour moves to a small dot next to the label instead. A number painted in
  // `warning` or `serious` sits below 3:1 contrast on the light surface and can be
  // close to invisible in daylight (see A5).
  const tile = (n, label, color) =>
    `<div><div class="tile-n">${n}</div><div class="tile-l"><span class="dot" style="background:${color}"></span> ${label}</div></div>`;
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

// The most actionable number on the page: which model actually burned the money, so
// an operator can move a job from opus to sonnet. Folded from every run's
// `usage.models` (see report.mjs / classify.mjs's parseModelUsage) — a model with no
// parsed cost stays out of the ranking entirely (costUsd null means unmeasured, not
// free) rather than showing as a $0.00 row that would rank it dead last for no reason.
function costByModelCard(agg) {
  const rows = Object.entries(agg.byModel ?? {})
    .filter(([, m]) => m.costUsd != null)
    .sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (!rows.length) {
    return `<div class="card"><h2>Cost by model</h2><div class="sub">no model cost recorded</div></div>`;
  }
  const max = rows.reduce((m, [, v]) => Math.max(m, v.costUsd), 0);
  const bars = rows.map(([name, v]) => `<div>
<div class="row"><span>${escapeHtml(name)}</span><span>${money(v.costUsd)}</span></div>
<div class="bar-track"><div class="bar-fill" style="width:${max > 0 ? Math.min(100, Math.round((v.costUsd / max) * 100)) : 0}%"></div></div>
</div>`).join('');
  return `<div class="card"><h2>Cost by model</h2>${bars}</div>`;
}

// How often runs were skipped for quota, split by day and by WHY: a subscription
// limit (`usage-limit`) burns real quota, an overload (`api-overload`) is Anthropic
// having a bad minute — same scheduling either way, very different operational
// meaning, and folding them together is exactly the confusion classifySkipReason
// (classify.mjs) exists to remove. `lastResetAt` is the verbatim text the most recent
// limit message quoted (report.mjs tracks it by timestamp, not input order) — the
// reporting form, not a parsed time, so it is escaped like any other outside text.
function quotaCard(agg) {
  const { usageLimit, apiOverload } = agg.totals.skips;
  const total = usageLimit + apiOverload;
  if (!total) {
    return `<div class="card"><h2>Quota</h2><div class="sub">no quota skips in ${agg.windowDays}d</div></div>`;
  }
  const days = agg.byDay.filter((d) => d.usageLimit || d.apiOverload);
  const table = days.map((d) =>
    `<tr><td>${escapeHtml(d.date)}</td><td>${d.usageLimit}</td><td>${d.apiOverload}</td></tr>`).join('');
  const reset = agg.totals.lastResetAt
    ? `<div class="sub">last reset quoted: “${escapeHtml(agg.totals.lastResetAt)}”</div>` : '';
  return `<div class="card">
<h2>Quota</h2>
<div class="hero">${total}</div>
<div class="sub">${usageLimit} usage-limit · ${apiOverload} overload</div>
${reset}
<details class="table-view"><summary>by day</summary>
<table><tr><td>day</td><td>usage-limit</td><td>overload</td></tr>${table}</table></details>
</div>`;
}

// How often a due job was held back by its own concurrency group (see CLAUDE.md,
// "Concurrency groups") — a silent skip that otherwise looks exactly like a job with
// nothing to do. Reads `agg.groupHolds`, which `aggregate()` (lib/report.mjs) folds
// from `tick.mjs`'s `group-held` log rows: one row per TICK, batching every hold that
// tick saw, so a job stuck behind a long-running groupmate for half an hour shows up
// here as one running total, not thirty separate lines. Sits next to Quota — the two
// answer the same question, "why did this job not run, when nothing is broken?" —
// quota for an exhausted subscription, this one for a busy groupmate. The held job's
// id, its group, and the holder's id are all job ids / group names an operator wrote
// into `jobs.yml`, so all three are escaped like any other outside value on this page.
function groupHoldsCard(agg) {
  const { total, rows } = agg.groupHolds ?? { total: 0, rows: [] };
  if (!total) {
    return `<div class="card"><h2>Group holds</h2><div class="sub">no group holds in ${agg.windowDays}d</div></div>`;
  }
  const lines = rows.map((r) =>
    `<tr><td>${escapeHtml(r.job)} · group ${escapeHtml(r.group)}</td><td>${r.count} held by ${escapeHtml(r.holder)}</td></tr>`).join('');
  return `<div class="card">
<h2>Group holds</h2>
<div class="hero">${total}</div>
<table>${lines}</table>
</div>`;
}

// The longest runs in the window, with the job's own timeout beside them where it has
// one — a run at 14m50s against a 15m timeout is about to start being killed, and
// duration alone does not say that. `jobMetaById` is the same EFFECTIVE-jobs lookup
// renderHtml already builds for jobPost, and `timeoutSec` is resolved the same
// job-then-defaults-then-900s way launch.mjs resolves it, so the timeout shown is the
// one the tick will actually enforce, profile and `defaults.yml` overrides included —
// not just a job's own field, which used to leave the column blank for any job that
// relied on `defaults.timeoutSec` (or on the built-in 900s) instead of setting its own.
function slowestRunsCard(agg, jobMetaById, defaults) {
  const rows = agg.slowestRuns ?? [];
  if (!rows.length) {
    return `<div class="card"><h2>Slowest runs</h2><div class="sub">no runs recorded this window</div></div>`;
  }
  const lines = rows.map((r) => {
    const timeoutSec = effectiveTimeoutSec(jobMetaById.get(r.job), defaults);
    const vsTimeout = timeoutSec ? ` / ${fmtDuration(timeoutSec * 1000)} timeout` : '';
    return `<tr><td>${escapeHtml(r.job ?? '—')}</td><td>${fmtDuration(r.durationMs)}${vsTimeout}${r.timedOut ? ' (timed out)' : ''}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Slowest runs</h2><table>${lines}</table></div>`;
}

// Token totals for the window — already summed in report.mjs and never shown before
// this. Tokens have no null-when-unmeasured state (unlike cost): every run either adds
// numbers or adds nothing, so 0 is always a real count, not "unknown". The empty case
// here is therefore keyed on `totals.runs`, not on the token fields themselves.
function tokensCard(agg) {
  if (!agg.totals.runs) {
    return `<div class="card"><h2>Tokens</h2><div class="sub">no token usage recorded this window</div></div>`;
  }
  const t = agg.totals.tokens;
  return `<div class="card">
<h2>Tokens</h2>
<div class="sub">in ${fmtNum(t.in)} · out ${fmtNum(t.out)} · cache read ${fmtNum(t.cacheRead)} · cache create ${fmtNum(t.cacheCreate)}</div>
<div class="sub">turns ${fmtNum(agg.totals.turns)}</div>
</div>`;
}

// Whatever used to sit in the header's small print — cron install state, the global
// pause (with its origin and reason), and the active speed profile — now lives here
// instead, so it is said once, not twice. The header keeps only what defends against
// a dead render job serving stale numbers: task name, problem count, window cost, and
// the generated-at stamp.
function healthCard(status) {
  const cron = status.installed === null ? 'unknown' : status.installed ? 'installed' : 'NOT installed';
  const pauseLine = status.paused
    ? `<div class="sub">paused${status.pauseReason ? ` (${escapeHtml(status.pauseReason)})` : ''}${status.pauseOrigin && status.pauseOrigin !== 'operator' ? ` [${escapeHtml(status.pauseOrigin)}]` : ''}</div>`
    : '';
  const profileLine = status.profile ? `<div class="sub">${profileNote(status.profile)}</div>` : '';
  return `<div class="card">
<h2>Scheduler health</h2>
<div class="sub">cron ${cron}</div>
${pauseLine}
${profileLine}
</div>`;
}

function recentCard(agg, now) {
  const rows = agg.recent.map((e) =>
    `<tr><td>${whenLabel(e.ts, now)} ${escapeHtml(e.job ?? '—')}</td><td>${escapeHtml(e.detail)}</td></tr>`).join('');
  return `<div class="card"><h2>Recent</h2><table>${rows || '<tr><td colspan="2">nothing yet</td></tr>'}</table></div>`;
}

// One line covering both ways a log read can come up short: a whole FILE that could
// not be read (permission error, mid-write) and a single LINE inside a readable file
// that did not parse. They are counted separately in logs.mjs — folding a file into
// the line count understated the damage (a whole day of runs can vanish with the
// footer still calling it "1 line"), so the wording must name whichever actually
// happened, together when both did, and say nothing when neither did (see A6).
function unreadableLogNote(agg) {
  const parts = [];
  if (agg.skippedFiles) parts.push(`${agg.skippedFiles} unreadable log file(s)`);
  if (agg.skippedLines) parts.push(`${agg.skippedLines} unreadable log line(s)`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// `jobs` is the EFFECTIVE jobs array (profile overrides applied) that pshed.mjs already
// builds for computeNext — the same one, passed through so each post can show its
// schedule/model/group. `defaults` (jobs.yml's `defaults:` block) rides along
// separately because resolveGroup needs it to resolve a group a job inherits rather
// than names itself; collectStatus's per-job objects carry neither, only runtime state.
export function renderHtml(status, agg, next, now, jobs = [], defaults = {}) {
  const jobMetaById = new Map(jobs.map((j) => [j.id, j]));
  const states = status.jobs.map((j) => ({ j, state: jobState(j) }));
  const problems = states.filter((s) => s.state.problem);
  const nonProblem = states.filter((s) => !s.state.problem);
  // A job whose failures are climbing but whose breaker has not tripped is NOT one of
  // the three problem states (breaker / self-pause / retry-pending) — the header count
  // must stay exactly those three, so a count that also includes jobs which never
  // actually stopped is a count nobody trusts. But it must not sit at the bottom of the
  // feed where nobody looks either, so it gets its own bucket, placed right after the
  // real problems and before the summary cards.
  const accumulating = nonProblem.filter((s) => isAccumulating(s.j, jobMetaById.get(s.j.id), defaults));
  const healthy = nonProblem.filter((s) => !isAccumulating(s.j, jobMetaById.get(s.j.id), defaults));
  const head = `${problems.length} problem${problems.length === 1 ? '' : 's'} · ${money(agg.totals.costUsd)} / ${agg.windowDays}d`;
  const post = ({ j, state }) => jobPost(j, state, jobMetaById.get(j.id), defaults, agg, next, now);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>p-shed · ${escapeHtml(status.task)}</title>
<style>${css()}</style></head>
<body>
<div class="feed">
<div class="card">
<h1>p-shed · ${escapeHtml(status.task)}</h1>
<div class="sub">${head}</div>
<div class="sub">generated ${dateStr(now)} ${hhmm(now)}</div>
</div>
${problems.map(post).join('')}
${accumulating.map(post).join('')}
${costByModelCard(agg)}
${quotaCard(agg)}
${groupHoldsCard(agg)}
${slowestRunsCard(agg, jobMetaById, defaults)}
${tokensCard(agg)}
${healthCard(status)}
${costCard(agg)}
${runsCard(agg)}
${healthy.map(post).join('')}
${recentCard(agg, now)}
<div class="card sub">window ${agg.windowDays} days${unreadableLogNote(agg)}</div>
</div>
</body></html>`;
}
