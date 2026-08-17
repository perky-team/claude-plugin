import { done, sessionsToDone, regressionRate, churn, capShare } from './metrics.mjs';

const byRun = (rows) => {
  const runs = new Map();
  for (const r of rows) {
    const key = `${r.arm} ${r.run}`;
    if (!runs.has(key)) runs.set(key, { arm: r.arm, run: r.run, sessions: [] });
    runs.get(key).sessions.push(r);
  }
  for (const v of runs.values()) v.sessions.sort((a, b) => a.session - b.session);
  return [...runs.values()];
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x, digits = 2) => (x === null || x === undefined ? '—' : x.toFixed(digits));
const spread = (xs) => (xs.length < 2 ? '—' : `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`);

// The cap is the session length now, so most sessions are SUPPOSED to hit it —
// the old warning, which said the numbers were void above one session in
// twenty, would fire on every healthy study and mean nothing.
//
// What is worth warning about is the opposite: an arm that barely ever reaches
// its budget. That means its sessions are ending for some other reason —
// erroring out, or finishing early — and the arms are then not being given the
// same amount of work after all, which is the one thing this design rests on.
const CAP_FLOOR = 0.5;

// A single number hides everything that matters about feature work: five runs
// with the same mean can be five identical runs or two disasters and three wins.
//
// `done` is the share of hidden TESTS green, not of requirements. Every test
// name starts with its requirement id, so the write-up can group by the `R\d+`
// prefix wherever "R7 was the last to go green" reads better than a percentage.
export function report(rows) {
  if (!rows.length) return '\nno runs yet\n';
  const runs = byRun(rows);
  const arms = [...new Set(runs.map((r) => r.arm))];

  const lines = ['',
    '| arm | runs | done | spread | sessions to done | regressions / hand-over | churn | $ per run | tokens / session |',
    '|---|---|---|---|---|---|---|---|---|'];
  const noisy = [];
  for (const arm of arms) {
    const mine = runs.filter((r) => r.arm === arm);
    const dones = mine.map((r) => done(r.sessions)).filter((x) => x !== null);
    const finished = mine.map((r) => sessionsToDone(r.sessions)).filter((x) => x !== null);
    const regs = mine.map((r) => regressionRate(r.sessions)).filter((x) => x !== null);
    const churns = mine.map((r) => churn(r.sessions)).filter((x) => x !== null);
    const costs = mine.map((r) => r.sessions.reduce((n, s) => n + (s.cost_usd ?? 0), 0));
    // All three input counts, not `input_tokens` alone. Measured on the first
    // real sessions: `input_tokens` came back as 18 and 54 while the same
    // sessions read 0.5M and 1.75M cached tokens. Almost everything an agent
    // carries arrives as cache reads, so the tax is invisible without them.
    const tokenCounts = mine.flatMap((r) => r.sessions)
      .map((s) => (s.usage
        ? (s.usage.input_tokens ?? 0)
          + (s.usage.cache_read_input_tokens ?? 0)
          + (s.usage.cache_creation_input_tokens ?? 0)
        : null))
      .filter((x) => typeof x === 'number' && x > 0);

    // Per arm, never pooled. One arm that is behaving differently averages away
    // to nothing against the others, and its own numbers still print as if they
    // were sound.
    const capped = capShare(mine.flatMap((r) => r.sessions));
    if (capped !== null && capped < CAP_FLOOR) noisy.push({ arm, capped });

    // "Sessions to done" means the finished runs only. Printing the mean
    // alone hid how many runs that mean is even about — 1 of 5 runs finishing
    // at session 3 and 5 of 5 finishing at session 6 both used to just print
    // a number, and the smaller, faster-looking number was the one that
    // barely worked at all.
    const sessionsCell = finished.length
      ? `${fmt(mean(finished), 1)} (${finished.length}/${mine.length})`
      : 'never';

    lines.push(`| ${arm} | ${mine.length} | ${fmt(mean(dones))} | ${spread(dones)} `
      + `| ${sessionsCell} | ${fmt(mean(regs))} `
      + `| ${fmt(mean(churns))} | ${fmt(mean(costs))} | ${fmt(mean(tokenCounts), 0)} |`);
  }

  // Fixed, not conditional on anything measured: with more than one arm on
  // the same table, a reader will compare all three cells side by side unless
  // told not to. `ptasks` vs `beads` differ by the tracker alone; `none` also
  // lacks the rule text, so it is missing two things, not one.
  if (arms.length > 1) {
    lines.push('',
      '**`ptasks` against `beads` is a clean comparison — both arms have a rule and a place to store items.**',
      '**Either against `none` is coarse: that arm is missing the rule text as well as the tracker.**');
  }

  for (const { arm, capped } of noisy) {
    lines.push('', `**only ${(capped * 100).toFixed(0)}% of \`${arm}\` sessions used their whole budget — `
      + 'the rest ended early, so this arm was not given the same amount of work as the others '
      + 'and its row cannot be compared with them**');
  }
  lines.push('');
  return lines.join('\n');
}
