// Every number this study publishes is computed here, from plain objects, with
// no file system and no spawning. That is deliberate: a wrong formula would be
// invisible in a $100 run and obvious in a unit test.

const scored = (sessions) => sessions.filter((s) => s.tests && Object.keys(s.tests).length);
const share = (tests) => {
  const ids = Object.keys(tests);
  return ids.filter((id) => tests[id]).length / ids.length;
};

/** Share of hidden tests green in the last session that scored. */
export function done(sessions) {
  const rows = scored(sessions);
  return rows.length ? share(rows.at(-1).tests) : null;
}

/** 1-based session where every hidden test was green for the first time. */
export function sessionsToDone(sessions) {
  for (const s of scored(sessions)) {
    if (share(s.tests) === 1) return s.session;
  }
  return null;
}

// A rate, not a count. A run that finished at session 4 had three hand-overs and
// one that ran all ten had nine; counting raw regressions would reward the fast
// arm twice, once for speed and once for reliability.
export function regressionRate(sessions) {
  const scoredSessions = scored(sessions);
  if (scoredSessions.length < 2) return null;

  let handovers = 0;
  let regressions = 0;
  for (let i = 1; i < sessions.length; i++) {
    const before = sessions[i - 1].tests;
    const after = sessions[i].tests;
    if (!before || !after) continue;
    handovers++;
    for (const id of Object.keys(before)) {
      if (before[id] && after[id] === false) regressions++;
    }
  }
  return handovers > 0 ? regressions / handovers : 0;
}

/** Lines written across the run, over lines that survived into the result. */
export function churn(sessions) {
  const written = sessions.reduce((n, s) => n + (s.changed_lines_from_prev ?? 0), 0);
  const kept = sessions.at(-1)?.changed_lines_from_seed ?? 0;
  return kept ? written / kept : null;
}

/** Share of sessions stopped by the per-session dollar cap. */
export function capShare(sessions) {
  return sessions.length
    ? sessions.filter((s) => s.hit_cap).length / sessions.length
    : null;
}
