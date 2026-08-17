import { describe, expect, it } from 'vitest';
import { escapeHtml, renderHtml } from '../lib/html.mjs';
import { aggregate } from '../lib/report.mjs';

const NOW = new Date('2026-08-14T14:32:00').getTime();
const at = (iso: string) => new Date(iso).getTime();

const status = (jobs: Record<string, unknown>[]) => ({
  action: 'status', task: 'pshed-1a2b3c4d', installed: true, paused: false, jobs,
});
const job = (over: Record<string, unknown> = {}) => ({
  id: 'worker', enabled: true, running: false, paused: false,
  breakerTripped: false, consecutiveFailures: 0, lastRun: at('2026-08-14T14:00:00'),
  lastExit: 0, ...over,
});
const page = (jobs: Record<string, unknown>[], next: Record<string, unknown> = {}) =>
  renderHtml(status(jobs), aggregate([], NOW), next, NOW);

describe('escapeHtml', () => {
  it('escapes the five characters that break markup', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('survives values that are not strings', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('renderHtml', () => {
  it('produces a complete document naming the task', () => {
    const html = page([job()]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('pshed-1a2b3c4d');
    expect(html).toContain('worker');
  });

  it('carries no script and loads nothing from the network', () => {
    const html = page([job({ pauseReason: 'x' })]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('escapes text that came from outside', () => {
    const html = page([job({ paused: true, pauseOrigin: 'self', pauseReason: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('counts a breaker, a self-pause and a retry as problems', () => {
    const html = page([
      job({ id: 'a', breakerTripped: true }),
      job({ id: 'b', paused: true, pauseOrigin: 'self' }),
      job({ id: 'c', lastSkipReason: 'api-overload', retryNotBefore: at('2026-08-14T15:00:00') }),
    ]);
    expect(html).toContain('3 problems');
  });

  it('does not count an operator pause as a problem', () => {
    const html = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding' })]);
    expect(html).toContain('0 problems');
  });

  it('gives self-pause and operator-pause different badges', () => {
    const self = page([job({ paused: true, pauseOrigin: 'self', pauseReason: 'verify went red' })]);
    const operator = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding' })]);
    expect(self).toContain('badge-self-pause');
    expect(operator).toContain('badge-held');
  });

  it('renders the next run as a time, as due, and as a dash', () => {
    const html = page(
      [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })],
      { a: { at: at('2026-08-14T15:00:00'), due: false }, b: { at: null, due: true }, c: { at: null, due: false } },
    );
    expect(html).toContain('next 15:00');
    expect(html).toContain('next due');
    expect(html).toContain('next —');
  });

  it('shows a run cost of an unmeasured window as a dash, not as zero', () => {
    expect(page([job()])).not.toContain('$0.00');
  });

  it('shows a measured zero cost as $0.00, not as a dash', () => {
    const agg = aggregate([{ ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0, usage: { costUsd: 0 } }], NOW);
    const html = renderHtml(status([job()]), agg, {}, NOW);
    expect(html).toContain('$0.00');
  });

  it('gives each job state its own badge', () => {
    const html = page([
      job({ id: 'a', breakerTripped: true }),
      job({ id: 'b', retryNotBefore: at('2026-08-14T15:00:00') }),
      job({ id: 'c', running: true }),
      job({ id: 'd', enabled: false }),
      job({ id: 'e' }),
    ]);
    expect(html).toContain('badge-breaker');
    expect(html).toContain('badge-retry');
    expect(html).toContain('badge-running');
    expect(html).toContain('badge-off');
    expect(html).toContain('badge-ok');
  });

  it('draws the daily chart with the theme colour variables, not literal light-mode hex', () => {
    const agg = aggregate([{ ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0, usage: { costUsd: 1.5 } }], NOW);
    const html = renderHtml(status([job()]), agg, {}, NOW);
    expect(html).toContain('fill="var(--series)"');
    expect(html).not.toContain('fill="#2a78d6"');
  });

  it('shows an unknown profile name as a problem, badged in the critical colour', () => {
    const html = renderHtml(
      { ...status([job()]), profile: { name: 'turbo', source: 'env', problem: 'unknown-name' } },
      aggregate([], NOW), {}, NOW,
    );
    expect(html).toContain('turbo');
    expect(html).toMatch(/unknown profile name/);
    // #d03b3b is STATUS.critical elsewhere on the page too, so pin the assertion to the
    // profile badge itself rather than a bare hex string that would pass by accident.
    // The colour lives on the badge's dot (A5) — its label text carries none.
    expect(html).toContain('badge-profile-problem"><span class="dot" style="background:#d03b3b">');
  });

  it('shows a missing profile file as a warning even when no profile name resolved', () => {
    const html = renderHtml(
      { ...status([job()]), profile: { name: null, source: 'none', file: '/etc/pace.txt', warning: 'file-missing' } },
      aggregate([], NOW), {}, NOW,
    );
    expect(html).toContain('profile —');
    expect(html).toMatch(/profile file missing/);
    expect(html).toContain('badge-profile-warning"><span class="dot" style="background:#fab219">');
  });

  it('shows an unreadable profile file as a warning, worded differently from missing', () => {
    const html = renderHtml(
      { ...status([job()]), profile: { name: 'fast', source: 'default', file: '/etc/pace.txt', warning: 'file-unreadable' } },
      aggregate([], NOW), {}, NOW,
    );
    expect(html).toMatch(/profile file unreadable/);
  });

  it('renders a failed run\'s output tail behind details, escaped, dated with when it ran', () => {
    const agg = aggregate([
      { ts: at('2026-08-14T09:00:00'), job: 'worker', outcome: 'failure', exit: 1, raw: '<script>alert(1)</script>' },
    ], NOW);
    const html = renderHtml(status([job({ breakerTripped: true })]), agg, {}, NOW);
    // A self-pause usually follows a run that exited 0, so the tail can be from an
    // OLDER failure than the one that caused the pause (C2). Dating the summary is
    // what stops an operator reading a stale tail as the cause.
    expect(html).toContain('<details><summary>show output (09:00)</summary><pre>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows no output details on a problem card when no raw tail was recorded', () => {
    const html = page([job({ breakerTripped: true })]);
    expect(html).not.toContain('show output');
  });

  it('defines both colour schemes', () => {
    const html = page([job()]);
    expect(html).toContain('#2a78d6');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('#3987e5');
  });

  it('puts a table view behind details for the daily chart', () => {
    expect(page([job()])).toContain('<details class="table-view"');
  });

  it('shows the generated time', () => {
    expect(page([job()])).toContain('14:32');
  });

  it('shows the generated date as well as the time, so a stale render cannot pass for fresh', () => {
    // A board job whose breaker tripped days ago still writes numbers into a page
    // rendered today. Time-only ("generated 14:32") reads as "just now" whatever day
    // it actually is — the date is what tells an operator the render itself is stale.
    expect(page([job()])).toContain('generated 2026-08-14 14:32');
  });

  describe('a disabled job with a stale retry (A1)', () => {
    // Reachable state: an api-overload skip writes retryNotBefore and nothing else;
    // a speed profile then disables the job. Nothing ever clears retryNotBefore for a
    // job that never runs again, so jobState and computeNext must agree it is simply
    // off, not stuck retrying forever.
    const disabledWithStaleRetry = job({ enabled: false, retryNotBefore: at('2026-08-10T00:00:00') });

    it('reads as disabled, not as a pending retry', () => {
      const html = page([disabledWithStaleRetry]);
      expect(html).toContain('badge-off');
      expect(html).not.toContain('badge-retry');
    });

    it('is not counted as a problem', () => {
      const html = page([disabledWithStaleRetry]);
      expect(html).toContain('0 problems');
    });
  });

  describe('cost-by-job bars (A2)', () => {
    const manyJobRecords = (n: number) => Array.from({ length: n }, (_, i) =>
      ({ ts: at('2026-08-14T10:00:00'), job: `job-${i + 1}`, outcome: 'success', exit: 0, usage: { costUsd: 1 } }));

    it('folds jobs past the eighth into one "other" row summing their cost', () => {
      const agg = aggregate(manyJobRecords(12), NOW);
      const html = renderHtml(status([job()]), agg, {}, NOW);
      const named = [...html.matchAll(/<span>(job-\d+|other)<\/span>/g)].map((m) => m[1]);
      expect(named).toHaveLength(9); // 8 named jobs + 1 "other"
      expect(named.filter((id) => id === 'other')).toEqual(['other']);
      expect(html).toContain('<span>other</span><span>$4.00</span>');
    });

    it('never lets a cost bar exceed 100% of its track', () => {
      const agg = aggregate(manyJobRecords(12), NOW);
      const html = renderHtml(status([job()]), agg, {}, NOW);
      const widths = [...html.matchAll(/bar-fill" style="width:([\d.]+)%/g)].map((m) => Number(m[1]));
      expect(widths.length).toBeGreaterThan(0);
      for (const w of widths) expect(w).toBeLessThanOrEqual(100);
      // The folded "other" row (sum $4) is the biggest bar shown, so it is the one
      // that must reach exactly 100% — proving the max is taken AFTER the fold.
      expect(widths).toContain(100);
    });
  });

  describe('next-run time formatting (A4)', () => {
    it('shows a today time as a bare time', () => {
      const html = page([job({ id: 'a' })], { a: { at: at('2026-08-14T18:00:00'), due: false } });
      expect(html).toContain('next 18:00');
    });

    it('shows a tomorrow time with its date', () => {
      const html = page([job({ id: 'a' })], { a: { at: at('2026-08-15T09:00:00'), due: false } });
      expect(html).toContain('next 2026-08-15 09:00');
    });

    it('shows a months-away time with its date, not a bare clock time', () => {
      const html = page([job({ id: 'a' })], { a: { at: at('2027-01-01T00:00:00'), due: false } });
      expect(html).toContain('next 2027-01-01 00:00');
      expect(html).not.toContain('next 00:00');
    });
  });

  describe('Recent list dates (C7)', () => {
    it('shows a bare time for a run from today', () => {
      const agg = aggregate([
        { ts: at('2026-08-14T09:00:00'), job: 'worker', outcome: 'success', exit: 0 },
      ], NOW);
      const html = renderHtml(status([job()]), agg, {}, NOW);
      expect(html).toContain('<td>09:00 worker</td>');
    });

    it('shows the date for a run from an earlier day in the 7-day window', () => {
      const agg = aggregate([
        { ts: at('2026-08-12T09:00:00'), job: 'worker', outcome: 'success', exit: 0 },
      ], NOW);
      const html = renderHtml(status([job()]), agg, {}, NOW);
      expect(html).toContain('<td>2026-08-12 09:00 worker</td>');
    });
  });

  describe('status colour contrast (A5)', () => {
    it('colours a badge\'s dot and icon, but leaves its label text in normal ink', () => {
      const html = page([job({ breakerTripped: true })]);
      // The exact markup badge() produces: colour on the dot and the icon span only,
      // then the label as plain text with no colour of its own.
      expect(html).toContain('badge-breaker"><span class="dot" style="background:#d03b3b"></span><span style="color:#d03b3b">⛔</span> breaker</span>');
    });

    it('keeps outcome tile numbers in normal ink, moving the status colour to a dot', () => {
      const html = page([job()]);
      expect(html).not.toMatch(/tile-n" style="color:/);
      // The colour still shows, on a dot next to the tile's label — STATUS.good, here.
      expect(html).toContain('tile-l"><span class="dot" style="background:#0ca30c"></span> ok');
    });
  });

  describe('unreadable log files vs. lines (A6)', () => {
    it('reports an unreadable file apart from an unreadable line', () => {
      const agg = { ...aggregate([], NOW), skippedLines: 2, skippedFiles: 1 };
      const html = renderHtml(status([job()]), agg, {}, NOW);
      expect(html).toContain('1 unreadable log file(s)');
      expect(html).toContain('2 unreadable log line(s)');
    });

    it('says nothing about unreadable logs when none were skipped', () => {
      expect(page([job()])).not.toContain('unreadable');
    });
  });

  it('loads its favicon from a data: URI, never from the network (C8)', () => {
    expect(page([job()])).toContain('<link rel="icon" href="data:,">');
  });

  describe('one feed, one post shape per job', () => {
    it('shows every job exactly once, problem or healthy', () => {
      const html = page([
        job({ id: 'a' }),
        job({ id: 'b', breakerTripped: true, breakerReason: 'exit 1' }),
        job({ id: 'c' }),
      ]);
      for (const id of ['a', 'b', 'c']) {
        const occurrences = html.match(new RegExp(`<strong>${id}</strong>`, 'g')) ?? [];
        expect(occurrences).toHaveLength(1);
      }
    });

    it('shows a healthy job\'s schedule, model and concurrency group', () => {
      const jobs = [{ id: 'worker', schedule: '0 */3 * * *', model: 'sonnet', concurrencyGroup: 'tree' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).toContain('0 */3 * * *');
      expect(html).toContain('sonnet');
      expect(html).toContain('group tree');
    });

    it('resolves a group a job inherits from defaults, not just its own field', () => {
      // resolveGroup (lib/concurrency.mjs) is the single place that knows a job with no
      // concurrencyGroup of its own still belongs to defaults.concurrencyGroup — reading
      // job.concurrencyGroup directly here would silently show no group for it.
      const jobs = [{ id: 'worker', schedule: '* * * * *' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, { concurrencyGroup: 'tree' });
      expect(html).toContain('group tree');
    });

    describe('model resolution (job then defaults, defect 1)', () => {
      it('uses the job\'s own model over defaults', () => {
        const jobs = [{ id: 'worker', schedule: '* * * * *', model: 'opus' }];
        const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, { model: 'sonnet' });
        expect(html).toContain('opus');
        expect(html).not.toContain('sonnet');
      });

      it('shows a model a job inherits from defaults, not just its own field', () => {
        // Setting `model:` once in `defaults` is the ordinary way to configure a loop.
        // Reading `jobMeta.model` directly used to show no model at all on any post in
        // such a loop, which reads like a bug rather than an inherited setting.
        const jobs = [{ id: 'worker', schedule: '* * * * *' }];
        const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, { model: 'sonnet' });
        expect(html).toContain('sonnet');
      });

      it('shows no model when neither the job nor defaults sets one', () => {
        const jobs = [{ id: 'worker', schedule: '* * * * *' }];
        const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
        // Only the schedule prints in the meta line — no stray " · " for a missing model.
        expect(html).toContain('<div class="sub">* * * * *</div>');
      });
    });

    it('renders a job with no matching metadata entry, without its schedule/model/group line', () => {
      // Reachable when a job is removed from jobs.yml but its state file (and so its
      // status entry) is still on disk — the fifth argument then has no entry for it.
      const html = renderHtml(status([job({ id: 'ghost' })]), aggregate([], NOW), {}, NOW, [], {});
      expect(html).toContain('<strong>ghost</strong>');
      expect(html).not.toContain('group ');
    });

    it('shows a job\'s guard freshness when it has recorded one', () => {
      const html = renderHtml(
        status([job({ lastGuard: { at: NOW - 40_000, outcome: 'quiet', reason: 'no work' } })]),
        aggregate([], NOW), {}, NOW,
      );
      expect(html).toContain('guard quiet 40s ago (no work)');
    });

    it('escapes a guard\'s reason text', () => {
      const html = renderHtml(
        status([job({ lastGuard: { at: NOW, outcome: 'quiet', reason: '<script>x</script>' } })]),
        aggregate([], NOW), {}, NOW,
      );
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });

    it('does not show a trouble line for a healthy job, even a held one with a reason', () => {
      // The three problem states are breaker / self-pause / retry-pending only — an
      // operator pause is deliberate and must not read like the other two.
      const html = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding for maintenance' })]);
      expect(html).not.toContain('holding for maintenance');
    });
  });

  describe('single-column feed layout', () => {
    it('lays the feed out as one column, centred, at every width', () => {
      const html = page([job()]);
      // No responsive breakpoint and no multi-column grid — a laptop must not fan the
      // feed out into several columns the way the old auto-fit grid did.
      expect(html).not.toContain('auto-fit');
      expect(html).not.toContain('minmax');
      expect(html).toMatch(/\.feed\{[^}]*flex-direction:column/);
      expect(html).toMatch(/\.feed\{[^}]*max-width:640px/);
      expect(html).toMatch(/\.feed\{[^}]*margin:0 auto/);
    });
  });

  describe('accumulating-failure line and bucket', () => {
    it('shows "N of M failures" once failures start climbing, before the breaker trips', () => {
      const html = page([job({ consecutiveFailures: 2 })]);
      expect(html).toContain('2 of 3 failures');
    });

    it('stops once the breaker has tripped — the trouble line already says so', () => {
      const html = page([job({ consecutiveFailures: 3, breakerTripped: true })]);
      expect(html).not.toContain('of 3 failures');
    });

    it('uses the job\'s own maxConsecutiveFailures over the built-in default', () => {
      const jobs = [{ id: 'worker', maxConsecutiveFailures: 5 }];
      const html = renderHtml(status([job({ consecutiveFailures: 2 })]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).toContain('2 of 5 failures');
    });

    it('falls back to defaults.maxConsecutiveFailures when the job sets none', () => {
      const html = renderHtml(status([job({ consecutiveFailures: 2 })]), aggregate([], NOW), {}, NOW, [], { maxConsecutiveFailures: 10 });
      expect(html).toContain('2 of 10 failures');
    });

    it('shows nothing when the breaker is disabled for the job (maxConsecutiveFailures 0)', () => {
      const html = renderHtml(status([job({ consecutiveFailures: 9 })]), aggregate([], NOW), {}, NOW, [], { maxConsecutiveFailures: 0 });
      expect(html).not.toContain('failures</div>');
    });

    it('does not count an accumulating-failure job as a problem', () => {
      const html = page([job({ consecutiveFailures: 2 })]);
      expect(html).toContain('0 problems');
    });

    it('places an accumulating job right after the real problems, above the summary cards and above healthy jobs', () => {
      const jobs = [
        job({ id: 'broken', breakerTripped: true }),
        job({ id: 'climbing', consecutiveFailures: 1 }),
        job({ id: 'fine' }),
      ];
      const html = renderHtml(status(jobs), aggregate([], NOW), {}, NOW, [], {});
      const iBroken = html.indexOf('<strong>broken</strong>');
      const iClimbing = html.indexOf('<strong>climbing</strong>');
      const iCostByModel = html.indexOf('Cost by model');
      const iFine = html.indexOf('<strong>fine</strong>');
      expect(iBroken).toBeGreaterThan(-1);
      expect(iBroken).toBeLessThan(iClimbing);
      expect(iClimbing).toBeLessThan(iCostByModel);
      expect(iCostByModel).toBeLessThan(iFine);
    });
  });

  describe('per-job outcome breakdown', () => {
    it('shows the runs/failed/skipped breakdown, omitting zero categories', () => {
      const records = [
        ...Array.from({ length: 36 }, (_, i) => ({ ts: at('2026-08-14T10:00:00') + i, job: 'worker', outcome: 'success', exit: 0 })),
        ...Array.from({ length: 3 }, (_, i) => ({ ts: at('2026-08-14T10:05:00') + i, job: 'worker', outcome: 'failure', exit: 1 })),
        ...Array.from({ length: 2 }, (_, i) => ({ ts: at('2026-08-14T10:10:00') + i, job: 'worker', outcome: 'skipped', reason: 'usage-limit' })),
      ];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW);
      expect(html).toContain('41 runs · 3 failed · 2 skipped');
    });

    it('adds the guard-error count and the cost when both are present', () => {
      const records = [
        { ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'guard-error', exit: 3 },
        { ts: at('2026-08-14T11:00:00'), job: 'worker', outcome: 'success', exit: 0, usage: { costUsd: 1.5 } },
      ];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW);
      expect(html).toContain('2 runs · 1 guard err · $1.50');
    });

    it('shows nothing for a job with no runs in the window', () => {
      const html = page([job()]);
      expect(html).not.toMatch(/\d+ runs?/);
    });
  });

  describe('prompt line', () => {
    it('shows the prompt trimmed to one line, with the full text behind details', () => {
      const jobs = [{ id: 'worker', prompt: 'Check the inbox and reply to anything urgent, then summarize the rest.' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).toContain('<summary>Check the inbox and reply to anything urgent, then summarize the rest.</summary>');
      expect(html).toContain('<pre>Check the inbox and reply to anything urgent, then summarize the rest.</pre>');
    });

    it('collapses a multi-line prompt to one line in the summary, keeping the original behind details', () => {
      const jobs = [{ id: 'worker', prompt: 'line one\nline two\nline three' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).toContain('<summary>line one line two line three</summary>');
      expect(html).toContain('<pre>line one\nline two\nline three</pre>');
    });

    it('trims a long prompt in the summary, but keeps the full text behind details', () => {
      const long = 'x'.repeat(120);
      const jobs = [{ id: 'worker', prompt: long }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).toContain(`<summary>${'x'.repeat(79)}…</summary>`);
      expect(html).toContain(`<pre>${long}</pre>`);
    });

    it('escapes a prompt that carries markup', () => {
      const jobs = [{ id: 'worker', prompt: '<script>alert(1)</script>' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('shows nothing when the job has no prompt in its metadata', () => {
      // No `<pre>` anywhere: no prompt block AND no raw-output tail, since there is no
      // agg data for this job either. Every other card on the page uses <table>/<div>.
      expect(page([job()])).not.toContain('<pre>');
    });
  });

  describe('cwd line', () => {
    it('shows the job\'s working directory when it sets one', () => {
      const jobs = [{ id: 'worker', cwd: '/srv/repo' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).toContain('cwd /srv/repo');
    });

    it('shows nothing when the job sets no cwd', () => {
      expect(page([job()])).not.toContain('cwd ');
    });

    it('escapes a cwd value', () => {
      const jobs = [{ id: 'worker', cwd: '<b>x</b>' }];
      const html = renderHtml(status([job()]), aggregate([], NOW), {}, NOW, jobs, {});
      expect(html).not.toContain('<b>x</b>');
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    });
  });

  describe('header keeps only task, problem count, window cost and generated-at', () => {
    it('matches the header sub-line exactly, even while paused with a profile problem', () => {
      const s = { ...status([job()]), paused: true, pauseReason: 'incident', pauseOrigin: 'deploy', profile: { name: 'turbo', source: 'env', problem: 'unknown-name' } };
      const html = renderHtml(s, aggregate([], NOW), {}, NOW);
      expect(html).toMatch(/<div class="sub">generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/div>/);
    });
  });

  describe('Scheduler health card', () => {
    it('shows cron install state, the pause with its reason and origin, and the profile', () => {
      const s = { ...status([job()]), installed: false, paused: true, pauseReason: 'incident', pauseOrigin: 'deploy', profile: { name: 'eco', source: 'file', file: '/x' } };
      const html = renderHtml(s, aggregate([], NOW), {}, NOW);
      expect(html).toContain('<h2>Scheduler health</h2>');
      expect(html).toContain('cron NOT installed');
      expect(html).toContain('paused (incident) [deploy]');
      expect(html).toContain('profile eco');
    });

    it('shows a plain cron-installed line and no pause line when nothing is wrong', () => {
      const html = page([job()]);
      expect(html).toContain('cron installed');
      expect(html).not.toContain('SCHEDULER PAUSED');
    });
  });

  describe('Cost by model card', () => {
    const modelRecord = (model: string, cost: number, ts = at('2026-08-14T10:00:00')) =>
      ({ ts, job: 'worker', outcome: 'success', exit: 0, usage: { models: { [model]: { costUsd: cost } } } });

    it('lists models sorted by cost descending', () => {
      const agg = aggregate([modelRecord('haiku', 0.53), modelRecord('opus', 11.4), modelRecord('sonnet', 4.2)], NOW);
      const html = renderHtml(status([job()]), agg, {}, NOW);
      const iOpus = html.indexOf('>opus<');
      const iSonnet = html.indexOf('>sonnet<');
      const iHaiku = html.indexOf('>haiku<');
      expect(iOpus).toBeGreaterThan(-1);
      expect(iOpus).toBeLessThan(iSonnet);
      expect(iSonnet).toBeLessThan(iHaiku);
      expect(html).toContain('$11.40');
    });

    it('says so when no run carried a parsed model cost', () => {
      expect(page([job()])).toContain('no model cost recorded');
    });

    it('escapes a model name', () => {
      const agg = aggregate([modelRecord('<script>x</script>', 1)], NOW);
      const html = renderHtml(status([job()]), agg, {}, NOW);
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });
  });

  describe('Quota card', () => {
    it('breaks skips down by reason and quotes the most recent reset', () => {
      const records = [
        { ts: at('2026-08-13T09:00:00'), job: 'worker', outcome: 'skipped', reason: 'usage-limit', resetAt: '3am' },
        { ts: at('2026-08-14T09:00:00'), job: 'worker', outcome: 'skipped', reason: 'api-overload' },
        { ts: at('2026-08-14T09:05:00'), job: 'worker', outcome: 'skipped', reason: 'api-overload' },
      ];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW);
      expect(html).toContain('1 usage-limit · 2 overload');
      expect(html).toContain('last reset quoted: “3am”');
    });

    it('says so when there were no quota skips in the window', () => {
      expect(page([job()])).toContain('no quota skips in 7d');
    });

    it('escapes the quoted reset text', () => {
      const records = [{ ts: at('2026-08-14T09:00:00'), job: 'worker', outcome: 'skipped', reason: 'usage-limit', resetAt: '<script>x</script>' }];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW);
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });
  });

  describe('Slowest runs card', () => {
    it('lists the longest runs with the job\'s own timeout beside them', () => {
      const records = [
        { ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0, durationMs: 890_000 },
        { ts: at('2026-08-14T11:00:00'), job: 'worker', outcome: 'success', exit: 0, durationMs: 46_000 },
      ];
      const jobs = [{ id: 'worker', timeoutSec: 900 }];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW, jobs, {});
      expect(html).toContain('14m50s');
      expect(html).toContain('15m00s timeout');
    });

    it('says so when no run in the window carried a duration', () => {
      expect(page([job()])).toContain('no runs recorded this window');
    });

    it('escapes a job id', () => {
      const records = [{ ts: at('2026-08-14T10:00:00'), job: '<script>x</script>', outcome: 'success', exit: 0, durationMs: 1000 }];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW);
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });

    it('resolves a job\'s timeout from defaults, not just its own field', () => {
      const records = [{ ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0, durationMs: 890_000 }];
      const jobs = [{ id: 'worker' }];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW, jobs, { timeoutSec: 1200 });
      expect(html).toContain('20m00s timeout');
    });

    it('falls back to the built-in 900s timeout when neither the job nor defaults sets one', () => {
      const records = [{ ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0, durationMs: 46_000 }];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW, [{ id: 'worker' }], {});
      expect(html).toContain('15m00s timeout');
    });

    it('caps one job\'s rows so several jobs can appear (defect 2)', () => {
      // A chronically slow job used to take every visible row — seven of seven in a
      // real render — leaving the card no way to show where time goes across the
      // whole scheduler.
      const dominant = Array.from({ length: 10 }, (_, i) =>
        ({ ts: at('2026-08-14T10:00:00') + i, job: 'planner', outcome: 'success', exit: 0, durationMs: 900_000 - i * 1000 }));
      const others = [
        { ts: at('2026-08-14T11:00:00'), job: 'worker', outcome: 'success', exit: 0, durationMs: 50_000 },
        { ts: at('2026-08-14T12:00:00'), job: 'chat', outcome: 'success', exit: 0, durationMs: 40_000 },
      ];
      const html = renderHtml(status([job()]), aggregate([...dominant, ...others], NOW), {}, NOW);
      expect(html).toContain('worker');
      expect(html).toContain('chat');
      const plannerRows = html.match(/<td>planner<\/td>/g) ?? [];
      expect(plannerRows.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Tokens card', () => {
    it('shows token and turn totals for the window', () => {
      const records = [{ ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0, usage: { in: 12000, out: 3400, cacheRead: 500, cacheCreate: 20, turns: 4 } }];
      const html = renderHtml(status([job()]), aggregate(records, NOW), {}, NOW);
      expect(html).toContain('in 12,000');
      expect(html).toContain('out 3,400');
      expect(html).toContain('turns 4');
    });

    it('says so when no run happened in the window', () => {
      expect(page([job()])).toContain('no token usage recorded this window');
    });
  });

  describe('extra-cards feed order', () => {
    it('lays out header, problems, accumulating, the five new cards, Cost, Runs, healthy, then Recent', () => {
      const jobs = [
        job({ id: 'broken', breakerTripped: true }),
        job({ id: 'climbing', consecutiveFailures: 1 }),
        job({ id: 'fine' }),
      ];
      const html = renderHtml(status(jobs), aggregate([], NOW), {}, NOW, [], {});
      const marks = [
        '<strong>broken</strong>', '<strong>climbing</strong>',
        'Cost by model', 'Quota', 'Slowest runs', 'Tokens', 'Scheduler health',
        'Cost · 7 days', 'Runs · 7 days',
        '<strong>fine</strong>', '<h2>Recent</h2>',
      ].map((m) => html.indexOf(m));
      expect(marks.every((i) => i >= 0)).toBe(true);
      for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeGreaterThan(marks[i - 1]);
    });

    it('has no card for group holds — the tick writes no log row for a skipped-group, so there is nothing to show', () => {
      expect(page([job()])).not.toContain('Group hold');
    });
  });

  describe('card headings follow the configured window, not a hardcoded 7', () => {
    it('shows the real number everywhere the window is named', () => {
      const html = renderHtml(status([job()]), aggregate([], NOW, { windowDays: 14 }), {}, NOW);
      expect(html).toContain('Cost · 14 days');
      expect(html).toContain('Runs · 14 days');
      expect(html).toContain('window 14 days');
      expect(html).not.toContain('Cost · 7 days');
      expect(html).not.toContain('Runs · 7 days');
    });

    it('the quota card names the configured window too', () => {
      const html = renderHtml(status([job()]), aggregate([], NOW, { windowDays: 14 }), {}, NOW);
      expect(html).toContain('no quota skips in 14d');
    });
  });
});
