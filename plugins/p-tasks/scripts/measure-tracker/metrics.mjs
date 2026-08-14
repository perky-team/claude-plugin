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
  let handovers = 0;
  let regressions = 0;
  for (let i = 1; i < sessions.length; i++) {
    const prevSession = sessions[i - 1];
    const curSession = sessions[i];
    const before = prevSession.tests;
    const after = curSession.tests;
    if (!before || !after) continue;
    // An errored session is scored anyway, and its `tests` map is whatever the
    // tree already looked like — carried over, not evidence of anything. A
    // pair either side of an error is not a hand-over the tracker actually
    // got to answer for, and counting it only ever pads the denominator,
    // pulling the rate down for whichever arm errors more.
    if (prevSession.error || curSession.error) continue;
    handovers++;
    for (const id of Object.keys(before)) {
      if (before[id] && after[id] === false) regressions++;
    }
  }
  return handovers ? regressions / handovers : null;
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
