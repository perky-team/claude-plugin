# p-shed HTML report — design

Date: 2026-08-14
Plugin: `plugins/p-shed/`

## Problem

p-shed collects everything an operator needs and shows almost none of it well.

- **Cost is recorded and never read.** Every run writes a `usage` block to
  `logs/<date>.jsonl` — dollars, tokens, turns, per model. Nothing reads it back. The
  only way to answer "which job is expensive" is to page through JSON by hand.
- **`status --human` is a wide table built for a terminal.** It is tab-separated and
  runs past 100 characters. On a phone it wraps into mush.
- **The loop runs on a headless box.** The operator is not at that terminal. Today the
  only way to look is to open an ssh session.

The operator has three questions and no good surface for any of them:

1. How much did the loop cost?
2. What is broken right now?
3. What runs next?

## What this is NOT

These bounds were settled during design and are part of the spec.

| Rejected | Why |
|---|---|
| An HTTP server inside p-shed (`pshed serve`) | p-shed stays a scheduler. It must not own a network surface, a port, or an access decision. |
| A separate dashboard plugin | It would have to read `.pshed/` internals — job state files, run markers, its own `jobs.yml` parser. That is what p-observe did, and p-observe is being removed. |
| A change to p-chat | p-chat does not know p-shed exists; the only thing they share is the number `75`. Delivery must not create a code link between plugins. |
| A text report for Telegram | Asked for and rejected: the operator wants a real page, not a message. |

**The rule this follows:** plugins in this repository are self-contained. The operator
wires them together in `jobs.yml` and in their own config. Code never does.

So p-shed gains exactly one thing: a command that prints a report. Who serves that
report, and where, is the operator's setup — an off-the-shelf static file server, not
our code.

## Architecture

```
 .pshed/state/*.json ┐
 .pshed/run/*        ├─▶ collectStatus()  ─┐          (already exists)
 .pshed/jobs.yml     ┘                     │
                                           ├─▶ renderHtml() ─▶ one self-contained
 .pshed/logs/*.jsonl ──▶ aggregate()  ─────┘                   HTML file
                                                                    │
        pshed report --html --out /home/me/board/index.html         │
                       ▲                                            ▼
                       │                              /home/me/board/index.html
      p-shed job "board", guard-only:                         │
      runs every 5 min, launches no Claude,                   │  caddy / nginx
      breaker catches a broken render                         │  (operator's own)
                                                              ▼
                                                     phone: http://box:8080
```

The whole delivery chain is operator configuration:

```yaml
# jobs.yml — the only link between the report and its delivery
- id: board
  schedule: "*/5 * * * *"
  guard: "pshed report --html --out /home/me/board/index.html && exit 75"
  prompt: "(guard-only) Render the board."
```

A guard-only job is the right carrier, not system cron: exit 75 means "quiet, nothing
to do", so no Claude is launched and the render costs nothing — while a render that
breaks returns some other code and trips p-shed's own breaker, which plain cron cannot
do.

## New module: `lib/report.mjs`

One exported function. Pure — no filesystem, no clock, no network.

| function | contract |
|---|---|
| `aggregate(records, now, { windowDays = 7 })` | Folds raw log records into the shape below. Never throws. Ignores records it does not understand. |

Returned shape:

```js
{
  windowDays: 7,
  from: 1783549200000,           // now - windowDays, day-aligned in LOCAL time
  to: 1784154000000,
  totals: {
    runs: 187,
    costUsd: 12.40,              // null when no record carried a usage block
    outcomes: { success: 148, failure: 6, skipped: 31, guardError: 2 },
    skips:    { usageLimit: 24, apiOverload: 7 },
    tokens:   { in: 1200000, out: 340000, cacheRead: 24000000, cacheCreate: 900000 },
    turns: 1840,
    apiMs: 98765000,
  },
  byDay: [{ date: '2026-08-08', costUsd: 1.20, runs: 24 }, /* … exactly 7 entries … */],
  byJob: { worker: { runs: 120, costUsd: 9.10, outcomes: {…}, lastTs: … } },
  recent: [{ ts, job, kind, detail }],   // newest first, at most 20
  skippedLines: 0,
}
```

`recent[].kind` is one of `success`, `failure`, `timeout`, `skipped`, `guard-error`,
`reclaimed-deploy-pause`. `detail` is one short line already fit to print: `exit 1
(46s)`, `api-overload`, `reclaimed 1 pause(s)`.

Rules that are easy to get wrong, so they are stated:

- **`costUsd` is `null`, never `0`, when nothing was measured.** "We do not know" and
  "it was free" are different facts and the page renders them differently. A run whose
  output did not parse logs no `usage` block at all, by p-shed's own design. When some
  runs carried a cost and others did not, the total is the sum of what is known; `null`
  means not one record in the window carried a number.
- **Days are bucketed from `ts` in LOCAL time, not from the log file name.** Log files
  are named by UTC date (`logs.mjs` uses `toISOString`), while schedules fire in local
  time (`cron.mjs` uses `getHours`). On UTC+3 the two disagree by three hours. The
  operator reads the chart against their own clock, so local wins. Never bucket by
  filename.
- **`byDay` is zero-filled.** A day with no runs is an entry with `runs: 0`, not a
  missing entry, so the chart always has `windowDays` bars and a quiet day is visible
  as a gap rather than as a shorter axis.
- **Reclaim rows are events, not runs.** A record carrying `action` and no `outcome`
  (`reclaimed-deploy-pause`) appears in `recent` and touches no counter. This is the
  same branch p-shed's README already requires of any log consumer.
- **Unknown fields are ignored, unknown outcomes are counted nowhere.** Log records
  gain fields over time; an older report must not crash on a newer log.

## New module: `lib/charts.mjs`

SVG generators. Pure functions returning strings. Split from page assembly because
geometry is worth testing on its own.

| function | contract |
|---|---|
| `barsByDay(byDay, opts)` | Vertical bars, one per day. Returns an `<svg>` string. |
| `barsByJob(byJob, opts)` | Horizontal bars, sorted by cost descending. Returns an `<svg>` string. |

`opts` is `{ width, height, series, muted, grid }` — the box in CSS pixels and three
color strings. The generators hold no palette of their own; `html.mjs` passes the
values in, so the colors live in exactly one place. Both accept an empty input and
return an empty-state SVG rather than a broken box. Jobs past the eighth in
`barsByJob` fold into one `other` row, never into a ninth color — with one series
there is no ninth color to reach for, and a chart of twenty rows is a table.

Mark rules, taken from the data-viz method and not negotiable at implementation time:

- **One series, one color.** Every bar is the same hue. Bar length already encodes the
  value; coloring bars darker-where-bigger would burn the only free channel to repeat
  what length says, and it fails the categorical color checks by construction.
- **A 2px surface-colored gap between neighbouring bars.** Not a border drawn around
  each bar.
- **4px rounded ends on the data end only**, anchored flat to the baseline.
- **Hairline grid and axis, one shade off the surface, solid.** Never dashed.
- **Labels are selective**: the highest day and the top job get a direct value label.
  Every other value is reachable from the table view (below). A number on every bar is
  chaos and goes unread.
- **The SVG box includes the axis label band.** A box sized to the plot alone gives the
  card a tiny nested scrollbar on a phone.

## New module: `lib/html.mjs`

| function | contract |
|---|---|
| `renderHtml(status, agg, now)` | Returns a complete HTML document as a string. Pure. |
| `escapeHtml(text)` | `& < > " '` → entities. Used on every value that came from outside. |

### The page

Order is deliberate: what is broken comes before what it cost, because the page is
opened when something feels wrong.

**A "problem" is exactly three states**: the breaker is tripped, the job paused
*itself*, or a quota retry is pending. An operator pause and a deploy pause are not
problems — somebody meant those, and counting them would make the header cry wolf every
time a human halted a job on purpose. The header count and the problem cards use the
same definition.

```
┌────────────────────────────┐   phone, one column
│ p-shed          14:32:07   │  ← generated-at, large. A stale page must
│ 2 problems · $12.40 / 7d   │    be obvious at a glance.
├────────────────────────────┤
│ ⛔ planner   breaker        │  ← problems first, one card each
│    3 fails · last 09:05    │
│    ▸ show output           │  ← <details>, the run's raw tail
├────────────────────────────┤
│ ⏳ chat      retry 09:12    │
│    api-overload · skip #3  │
├────────────────────────────┤
│ COST · 7 days      $12.40  │  ← hero number
│  ▁▂▅▃█▂▁                   │  ← barsByDay
│  WHERE IT GOES             │
│  worker      ███████ $9.10 │  ← barsByJob
│  ▸ table                   │  ← table-view twin, no JS
├────────────────────────────┤
│ 187 runs                   │
│  ✓ 148   ✗ 6   ⏭ 31   ⚠ 2  │  ← four stat tiles, NOT one stacked bar
├────────────────────────────┤
│ ● worker    running 4m     │  ← healthy jobs, below the fold
│   next 15:00 · $9.10       │
├────────────────────────────┤
│ RECENT                     │
│  14:32 worker   launched   │
└────────────────────────────┘
```

On a wider screen the same markup reflows into two or three columns with a CSS grid
`auto-fit`. There is no second layout to maintain.

### Colors

Values come from the data-viz reference palette. Both were run through
`scripts/validate_palette.js`; the results are recorded here so nobody has to re-derive
them.

| Role | Light | Dark | Validator |
|---|---|---|---|
| Series (all bars) | `#2a78d6` | `#3987e5` | ALL CHECKS PASS in both modes |
| Surface | `#fcfcfb` | `#1a1a19` | — |
| Primary ink | `#0b0b0b` | `#ffffff` | — |
| Secondary ink | `#52514e` | `#c3c2b7` | — |
| Muted (axis, labels) | `#898781` | `#898781` | — |
| Gridline | `#e1e0d9` | `#2c2c2a` | — |

Job state badges use the fixed status palette, one color per badge, never two side by
side:

| State | Token | Hex | Icon |
|---|---|---|---|
| running | series blue | `#2a78d6` / `#3987e5` | ● |
| healthy, waiting | good | `#0ca30c` | ○ |
| retry pending (quota / overload) | warning | `#fab219` | ⏳ |
| paused by the job itself | serious | `#ec835a` | ⏸ |
| paused by an operator or a deploy | muted | `#898781` | ⏸ |
| breaker tripped | critical | `#d03b3b` | ⛔ |
| disabled | muted | `#898781` | ○ |

Two decisions here are load-bearing:

- **Self-pause and operator-pause get different colors.** p-shed already records
  `pauseOrigin`. A job that stopped itself because its own verify went red is a
  problem; a job an operator halted on purpose is not. Painting them the same throws
  away a distinction the scheduler went to trouble to keep.
- **Run outcomes are four stat tiles, not one stacked proportion bar.** This was the
  first design and the validator killed it: as adjacent fills, critical ↔ good measure
  ΔE 4.1 under deuteranopia (red beside green — the classic failure) and serious ↔
  warning measure ΔE 13.6 for normal vision, below the hard floor of 15. Status colors
  are built to be read **alone**, next to an icon and a label. Four tiles is also the
  truer form: the reader wants the failure count, not the share of a whole.

Every badge carries an icon **and** a text label. On the light surface `warning` (1.79)
and `serious` (2.57) sit below 3:1 contrast, so the label is not decoration — it is what
carries the meaning.

Dark mode is a second set of chosen values under `prefers-color-scheme: dark`, not an
automatic inversion.

### Rules for the page

- **No JavaScript at all.** Charts are server-rendered SVG; expanding sections use the
  native `<details>` element. The page must work as a `file://` document opened from a
  downloaded copy.
- **Nothing is loaded from the network.** No fonts, no images, no stylesheets, no
  favicon fetch. CSS lives in one inline `<style>`. The page is opened from a phone,
  often on a bad connection, and a half-loaded dashboard is worse than a plain one.
  A test asserts the rendered document contains no `http://`, `https://`, or `<script`.
- **Every chart has a table-view twin** behind a `<details>`. Without JavaScript there
  is no tooltip, and a value no reader can reach is a value the page does not show.
  Phones have no hover either, so this is not a downgrade — it is the only correct form.
- **Everything from outside is escaped.** Pause reasons, breaker reasons, guard
  reasons, job ids, prompts, and the `raw` output tail are all attacker-adjacent text
  that reaches the page. `escapeHtml` is applied at every interpolation, and a test
  feeds a `<script>` tag through a pause reason.
- **The generated-at time is prominent.** The page is a snapshot rendered by a job on a
  schedule. If that job dies, the page keeps serving stale numbers, and nothing else on
  the page would reveal it.

## Additions to existing modules

### `lib/logs.mjs`

| function | contract |
|---|---|
| `readLogRecords(root, sinceMs)` | Reads every `*.jsonl` in the log directory, parses line by line, returns `{ records, skippedLines }` with records at or after `sinceMs`. Missing directory returns empties. Never throws. |

A line that does not parse is skipped and counted, never fatal. The tick appends to
these files while the report reads them, so a torn final line is expected, not an error.
Reading every file in the directory (at most seven, by the existing rotation) is
deliberate: filtering by file name would reintroduce the UTC/local skew described above.

### `lib/cron.mjs`

| function | contract |
|---|---|
| `nextRun(cronSpec, fromMs)` | The next minute at or after `fromMs + 1min` that the spec matches, or `null` if none within 40 days. |

It walks forward a minute at a time through the existing matcher. Forty days covers a
monthly schedule (`0 0 1 * *`) with room to spare; the worst case is 57,600 matcher
calls, which is nothing against reading the logs. A spec that can never match — day 30
of February — returns `null` and the page prints `—`.

### `pshed.mjs`

New command:

    pshed report [--json | --html] [--out <path>]

| Aspect | Decision |
|---|---|
| Default format | `--json`, matching `status`. `--html` produces the page. |
| `--out <path>` | Writes to that path. Without it the report goes to stdout. |
| Writing | Temp file in the **same directory**, then `rename` — the pattern p-shed already uses for `run/DEPLOY`. A browser must never fetch a half-written page, and rename is only atomic within one filesystem. |
| Exit codes | `0` ok / `1` environment (no `.pshed/`, unwritable target) / `2` validation (`--json` and `--html` together). Matches the existing contract. |
| Process exit | **Never `process.exit()`** — set `process.exitCode` and return. This command is the worst possible place to break that rule: an HTML page is far larger than one pipe buffer, and a hard exit truncates it silently on Linux while looking perfect on Windows. `plugins/p-shed/CLAUDE.md` records the measured case (853,212 bytes to a file, 65,536 through a pipe). |
| Read-only | The command writes nothing under `.pshed/` — no state, no log row. Running it never disturbs the tick. |

## Error handling

The report is a read-only view. It must never be the reason a loop stops.

| Condition | Behaviour |
|---|---|
| A log line does not parse | Skip it, count it, print the count in the page footer |
| A log file cannot be read | Skip that file, count it the same way |
| No log directory at all | Empty aggregate; the page renders with zeros and says so |
| A `usage` block is missing or partly non-numeric | Take the numbers that are there, leave the rest out; `costUsd` stays `null` |
| A job has no state file yet | Render it as never run |
| `nextRun` finds no match in 40 days | Print `—` |
| No `.pshed/` directory | Exit 1 with a message naming the directory |
| `--out` path not writable | Exit 1 naming the path; leave no temp file behind |

## Testing

Every new unit is a pure function, so most of this needs no filesystem.

| File | Covers |
|---|---|
| `__tests__/report.test.ts` | `aggregate`: cost sums; `null` vs `0`; local-time day bucketing across a UTC boundary; zero-filled days; reclaim rows counted as events and not as runs; corrupt lines counted; unknown outcome values ignored |
| `__tests__/charts.test.ts` | `barsByDay` / `barsByJob`: bar geometry for known inputs, an all-zero series, a single day, the 2px gaps, the axis band inside the SVG box |
| `__tests__/html.test.ts` | `renderHtml`: job ids present; `<script>` in a pause reason is escaped; the right badge per state, including self-pause vs operator-pause; both color blocks present; no `http://`, `https://`, or `<script` in the output; a `<details>` table twin per chart |
| `__tests__/cron-nextrun.test.ts` | `*/15 * * * *`, `0 9 * * *`, `0 0 1 * *`, a never-matching spec, and a `from` that sits exactly on a matching minute |
| `__tests__/cli-report-e2e.test.ts` | Real CLI in a temp root: `--json` parses; `--html --out` writes a readable file and leaves no temp file; both flags at once exits 2; a missing `.pshed/` exits 1 |
| `__tests__/stdout-pipe.test.ts` | Extend the existing file to cover `report --html` through a pipe — the largest output the CLI produces, so the truncation bug this test exists for shows here first |

Per `.claude/CLAUDE.md`, the whole suite runs under WSL on Node 24+ before this is
called verified. A Windows-only run cannot see the pipe-truncation failure at all.

## README additions

A short recipe section, because the delivery half is setup rather than code:

- `apt install caddy`, a three-line `Caddyfile` pointing at the output folder, and
  `basicauth`. The page shows job prompts, pause reasons, and raw output tails; on a
  home network everyone on it can read those. The password line is not optional advice.
- Put the output folder somewhere the loop's own user owns (`/home/me/board`), not
  `/var/www`. A permission error inside a guard is a bad place to spend an evening.
- The guard-only job above, with a note that the breaker is what makes a broken render
  visible.

## Out of scope

An HTTP server in p-shed. Any authentication. Any change to p-chat. Charts over more
than the seven days the logs keep. Watching more than one `.pshed/` at a time. Automatic
page refresh. PNG or PDF export. A `--human` text format.

## Known limits, accepted

- **Seven days is the whole history.** `rotateLogs` deletes older files with a hardcoded
  retention, so a monthly cost trend is not buildable from this data. Making retention
  configurable, or writing a daily rollup before deleting, is a separate change and is
  not part of this one.
- **The page is as fresh as the job that wrote it.** A dead render job leaves a page
  that looks alive. The prominent generated-at stamp is the whole defence, chosen over
  adding a second watchdog.
- **Reaching it from outside the home network** needs a tunnel the operator installs.
  Nothing in this design blocks that, and nothing in it helps.
