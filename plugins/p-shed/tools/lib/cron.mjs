function fieldMatcher(field, min, max) {
  const parts = field.split(',');
  const ranges = parts.map((p) => {
    let step = 1;
    let range = p;
    const slash = p.indexOf('/');
    if (slash !== -1) { step = parseInt(p.slice(slash + 1), 10); range = p.slice(0, slash); }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = parseInt(a, 10); hi = parseInt(b, 10); }
    else { lo = hi = parseInt(range, 10); }
    if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(step) || step < 1) {
      throw new Error(`invalid cron field: ${field}`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`invalid cron field: ${field}`);
    }
    return { lo, hi, step };
  });
  return (v) => ranges.some(({ lo, hi, step }) => v >= lo && v <= hi && (v - lo) % step === 0);
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron: expected 5 fields, got ${fields.length}`);
  const [mi, hr, dom, mon, dow] = fields;
  return {
    raw: { dom, dow },
    minute: fieldMatcher(mi, 0, 59),
    hour: fieldMatcher(hr, 0, 23),
    dom: fieldMatcher(dom, 1, 31),
    month: fieldMatcher(mon, 1, 12),
    dow: fieldMatcher(dow, 0, 6),
  };
}

export function matches(cron, date) {
  if (!cron.minute(date.getMinutes())) return false;
  if (!cron.hour(date.getHours())) return false;
  if (!cron.month(date.getMonth() + 1)) return false;
  const domR = cron.raw.dom !== '*';
  const dowR = cron.raw.dow !== '*';
  const d = cron.dom(date.getDate());
  const w = cron.dow(date.getDay());
  // Standard cron: when both day-of-month and day-of-week are restricted, either may match.
  return domR && dowR ? (d || w) : (d && w);
}

export function isDue(cron, lastRunMs, nowMs) {
  const MIN = 60_000;
  const start = Math.max(lastRunMs ?? 0, nowMs - 24 * 60 * MIN);
  let t = Math.floor(start / MIN) * MIN + MIN;      // first whole minute after start
  const end = Math.floor(nowMs / MIN) * MIN;        // current whole minute
  for (; t <= end; t += MIN) {
    if (matches(cron, new Date(t))) return true;
  }
  return false;
}

// The first whole minute strictly after `fromMs` that this spec matches, or null.
//
// It walks minute by minute through the same matcher the tick uses, so it can never
// disagree with it. Forty days covers a monthly schedule (`0 0 1 * *`) from any starting
// day; the worst case is 57,600 matcher calls, which is far cheaper than reading the
// logs the same command reads anyway. A spec that can never match — the 30th of
// February — returns null rather than spinning.
export function nextRun(cron, fromMs) {
  const MIN = 60_000;
  const CAP = 40 * 24 * 60;
  let t = Math.floor(fromMs / MIN) * MIN + MIN;
  for (let i = 0; i < CAP; i++, t += MIN) {
    if (matches(cron, new Date(t))) return t;
  }
  return null;
}
