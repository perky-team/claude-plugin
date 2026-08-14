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

  const lines = ['', '| arm | runs | done | spread | sessions to done | regressions / hand-over | churn | $ per run |',
    '|---|---|---|---|---|---|---|---|'];
  for (const arm of arms) {
    const mine = runs.filter((r) => r.arm === arm);
    const dones = mine.map((r) => done(r.sessions)).filter((x) => x !== null);
    const finished = mine.map((r) => sessionsToDone(r.sessions)).filter((x) => x !== null);
    const regs = mine.map((r) => regressionRate(r.sessions)).filter((x) => x !== null);
    const churns = mine.map((r) => churn(r.sessions)).filter((x) => x !== null);
    const costs = mine.map((r) => r.sessions.reduce((n, s) => n + (s.cost_usd ?? 0), 0));
    lines.push(`| ${arm} | ${mine.length} | ${fmt(mean(dones))} | ${spread(dones)} `
      + `| ${finished.length ? fmt(mean(finished), 1) : 'never'} | ${fmt(mean(regs))} `
      + `| ${fmt(mean(churns))} | ${fmt(mean(costs))} |`);
  }

  const capped = capShare(rows);
  if (capped !== null && capped > 0.05) {
    lines.push('', `**the cap bound in ${(capped * 100).toFixed(0)}% of sessions — `
      + 'the regression numbers above are void until the per-session cap goes up**');
  }
  lines.push('');
  return lines.join('\n');
}
