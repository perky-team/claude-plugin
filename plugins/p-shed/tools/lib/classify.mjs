// Classify a finished `claude -p` run so the circuit breaker can tell a genuine
// code/infra failure apart from a Claude usage-limit or a transient API overload —
// both quota/infra conditions, not job failures. A usage-limit run must be a SKIP
// (breaker untouched, next tick retries when the window resets), never an increment.
//
// Claude Code has NO distinct exit code and NO distinct JSON subtype for a usage
// limit — every limit type emits a near-identical human message — so detection is by
// MESSAGE TEXT (plus a structured-JSON fallback), the same approach mature tools
// (e.g. claude-auto-retry) use. The pattern is a single const, overridable so a new
// message shape can be handled without a code change (see resolveUsageLimitPattern).

// The two families are kept SEPARATE so the skip can be reported honestly (see
// classifySkipReason): a subscription limit burns real quota and carries a reset
// time; a 529 is the API having a bad minute. Both skip, but logging both as
// "usage-limit" made a live deployment read as quota-starved when every skip was
// actually an overload.

// Subscription / plan limits (5-hour "session", weekly, Opus, extra usage, credits).
export const SUBSCRIPTION_LIMIT_PATTERN = [
  '[0-9]+-hour limit',
  'usage limit reached',
  'hit your.{0,20}limit',
  'out of extra usage',
  'out ?of ?credits',
  'credit balance is too low',
].join('|');

// Transient API errors. Numeric HTTP codes match ONLY inside an `api error …`
// context, never bare, so an ordinary "500 items" line can't trip it.
export const API_OVERLOAD_PATTERN = [
  'rate_limit_error',
  'overloaded_error',
  'server is temporarily limiting',
  'api error[:( ].{0,8}(429|529|500|502|503|504)',
].join('|');

// Built-in detection pattern (matched case-insensitively): either family means SKIP.
export const DEFAULT_USAGE_LIMIT_PATTERN = [SUBSCRIPTION_LIMIT_PATTERN, API_OVERLOAD_PATTERN].join('|');

const SUBSCRIPTION_RE = new RegExp(SUBSCRIPTION_LIMIT_PATTERN, 'i');
const API_OVERLOAD_RE = new RegExp(API_OVERLOAD_PATTERN, 'i');

// Resolve the active pattern: jobs.yml `defaults.usageLimitPattern` wins, then the
// PSHED_USAGE_LIMIT_PATTERN env var, then the built-in default. One knob, so a
// missed message can be patched in jobs.yml (checked in) or via env (break-glass)
// after the self-reveal log shows the exact text — see tick.mjs.
export function resolveUsageLimitPattern(defaults = {}) {
  return defaults?.usageLimitPattern
    ?? process.env.PSHED_USAGE_LIMIT_PATTERN
    ?? DEFAULT_USAGE_LIMIT_PATTERN;
}

function textOf(out, err) {
  return [out, err].filter((s) => typeof s === 'string' && s.length > 0).join('\n');
}

// A user-supplied override may be an invalid regex; degrade to the built-in default
// rather than throwing and crashing the whole tick.
function compile(pattern) {
  try { return new RegExp(pattern, 'i'); }
  catch { return new RegExp(DEFAULT_USAGE_LIMIT_PATTERN, 'i'); }
}

function parseObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// Best-effort parse of the `--output-format json` result object from stdout. Returns
// the object or null (partial / non-JSON output — e.g. a timeout-killed run).
//
// Salvage scans LINES from the end (the result object is one line and is emitted last)
// rather than from the last `{`: a real result nests `usage`/`modelUsage`, so
// `lastIndexOf('{')` lands on an inner brace and any noise around the JSON — a wrapper
// warning before it, an npm notice after it — used to lose the whole result.
function parseResult(out) {
  if (typeof out !== 'string') return null;
  const s = out.trim();
  if (!s) return null;
  const clean = parseObject(s);
  if (clean) return clean;
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i].indexOf('{');
    if (j < 0) continue;
    const v = parseObject(lines[i].slice(j));
    if (v) return v;
  }
  const k = s.lastIndexOf('{');
  return k >= 0 ? parseObject(s.slice(k)) : null;
}

// First finite number among the candidates, else undefined. Deliberately strict —
// a non-numeric field is DROPPED rather than coerced, so a malformed result yields a
// smaller block instead of `NaN`/`null` noise in the log.
function num(...candidates) {
  for (const v of candidates) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function put(obj, key, value) {
  if (value !== undefined) obj[key] = value;
}

// Per-model roll-up: which model burned the tokens. Entries with nothing usable are
// dropped, so `models` is either meaningful or absent.
function parseModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return undefined;
  const models = {};
  for (const [name, m] of Object.entries(modelUsage)) {
    if (!m || typeof m !== 'object') continue;
    const e = {};
    put(e, 'in', num(m.inputTokens, m.input_tokens));
    put(e, 'out', num(m.outputTokens, m.output_tokens));
    put(e, 'costUsd', num(m.costUSD, m.costUsd, m.cost_usd));
    if (Object.keys(e).length) models[name] = e;
  }
  return Object.keys(models).length ? models : undefined;
}

// Compact cost/usage block for the run log — what a run actually COST, which duration
// alone cannot answer across jobs on different models and effort levels. Recorded for
// EVERY run with a parseable result, success included (the successful runs are exactly
// the expensive ones). Reuses parseResult, so the salvage path (log noise before the
// JSON, truncated output) is shared with classification.
//
// Contract: never throws and never partially poisons a row — anything missing,
// non-numeric or absent is omitted, and a result with no usable numbers returns
// undefined so the caller simply omits the whole block. A weird run must not be able
// to wedge the scheduler loop.
export function parseUsage(out) {
  try {
    const r = parseResult(out);
    if (!r || typeof r !== 'object') return undefined;
    const u = r.usage && typeof r.usage === 'object' ? r.usage : {};
    const block = {};
    put(block, 'costUsd', num(r.total_cost_usd, r.totalCostUsd));
    put(block, 'in', num(u.input_tokens, u.inputTokens));
    put(block, 'out', num(u.output_tokens, u.outputTokens));
    put(block, 'cacheRead', num(u.cache_read_input_tokens, u.cacheReadInputTokens));
    put(block, 'cacheCreate', num(u.cache_creation_input_tokens, u.cacheCreationInputTokens));
    put(block, 'turns', num(r.num_turns, r.numTurns));
    put(block, 'apiMs', num(r.duration_api_ms, r.durationApiMs));
    put(block, 'models', parseModelUsage(r.modelUsage));
    return Object.keys(block).length ? block : undefined;
  } catch {
    return undefined;
  }
}

// A run "failed" if the process exited non-zero (null = timeout/spawn error counts)
// or the JSON result carries `is_error: true`. Only failed runs are candidates for a
// usage-limit reclassification — a clean success is never a limit.
function isFailed(exitCode, result) {
  return exitCode !== 0 || result?.is_error === true;
}

// HTTP statuses worth retrying on the next tick. Everything else — 400 bad request,
// 401 expired credential, 403 revoked key — will fail identically forever, so it must
// NOT read as a limit: it has to reach the breaker. Treating any non-null
// api_error_status as a limit turned a dead credential into an infinite silent skip
// that looked healthy to every watchdog keyed on breakerTripped.
const RETRYABLE_API_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

function isRetryableApiStatus(status) {
  const n = typeof status === 'string' ? Number(status) : status;
  return typeof n === 'number' && Number.isFinite(n) && RETRYABLE_API_STATUSES.has(n);
}

// Structured signal: an is_error result tagged with a RETRYABLE API-error status, or
// carrying a 429/529 overload code. This ties the numeric code to a real API-error
// context (never a bare number elsewhere in the output).
function structuredLimit(result) {
  if (!result || result.is_error !== true) return false;
  if (isRetryableApiStatus(result.api_error_status)) return true;
  return /\b(429|529)\b/.test(JSON.stringify(result));
}

// -> "success" | "usage_limit" | "failure". `pattern` defaults to the env/built-in
// resolution; the caller passes the jobs.yml-resolved pattern for full precedence.
export function classifyRun(exitCode, out, err, pattern = resolveUsageLimitPattern()) {
  const result = parseResult(out);
  if (isFailed(exitCode, result)) {
    if (compile(pattern).test(textOf(out, err)) || structuredLimit(result)) return 'usage_limit';
  }
  return exitCode === 0 ? 'success' : 'failure';
}

// -> "usage-limit" | "api-overload": WHY a run classified as `usage_limit` was
// skipped. Reporting only — scheduling is identical for both (skip, breaker
// untouched, next tick retries) — but the operator needs to tell "we are out of
// quota" from "Anthropic had a bad minute". Deliberately a SEPARATE helper rather
// than a wider classifyRun return, so every existing caller/test of the 3-way
// classification stays valid.
//
// Subscription wins when both signatures are present: it is the more consequential
// state and the one carrying a reset time. A match that comes only from a custom
// `usageLimitPattern` override falls back to "usage-limit" — that is what the knob
// claims to detect.
export function classifySkipReason(out, err) {
  const text = textOf(out, err);
  if (SUBSCRIPTION_RE.test(text)) return 'usage-limit';
  if (API_OVERLOAD_RE.test(text) || structuredLimit(parseResult(out))) return 'api-overload';
  return 'usage-limit';
}

// Best-effort: pull a human reset time out of a limit message ("resets 3am",
// "reset at 2026-01-02 15:00"). Returns the matched string or undefined — purely
// informational (shown in status/logs); scheduling is unaffected either way. The
// capture excludes CR/LF explicitly (a `.` would exclude LF but keep CR, so a
// Windows CRLF tail — every headless run has one — would otherwise defeat it).
export function parseResetAt(out, err) {
  const m = /reset[s]?\s+(?:at\s+)?([^\r\n.·∙|]{1,40})/i.exec(textOf(out, err));
  const v = m && m[1].trim();
  return v || undefined;
}

// For self-reveal logging: the combined output, trimmed and tail-truncated, so a
// missed limit message is visible in the log without bloating it. Keeps the TAIL
// because the `--output-format json` result and any error land at the end.
export function truncateOutput(out, err, max = 2000) {
  const t = textOf(out, err).trim();
  return t.length > max ? t.slice(-max) : t;
}
