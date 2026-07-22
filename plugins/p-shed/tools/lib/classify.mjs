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

// Built-in detection pattern (matched case-insensitively). Covers subscription usage
// limits and transient API overloads. Numeric HTTP codes match ONLY inside an
// `api error …` context, never bare, so an ordinary "500 items" line can't trip it.
export const DEFAULT_USAGE_LIMIT_PATTERN = [
  // subscription / plan limits (5-hour "session", weekly, Opus, extra usage, credits)
  '[0-9]+-hour limit',
  'usage limit reached',
  'hit your.{0,20}limit',
  'out of extra usage',
  'out ?of ?credits',
  'credit balance is too low',
  // transient API errors
  'rate_limit_error',
  'overloaded_error',
  'server is temporarily limiting',
  'api error[:( ].{0,8}(429|529|500|502|503|504)',
].join('|');

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

// Best-effort parse of the `--output-format json` result object from stdout. Returns
// the object or null (partial / non-JSON output — e.g. a timeout-killed run).
function parseResult(out) {
  if (typeof out !== 'string') return null;
  const s = out.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* not clean JSON — try to salvage below */ }
  const i = s.lastIndexOf('{');
  if (i >= 0) { try { return JSON.parse(s.slice(i)); } catch { /* give up */ } }
  return null;
}

// A run "failed" if the process exited non-zero (null = timeout/spawn error counts)
// or the JSON result carries `is_error: true`. Only failed runs are candidates for a
// usage-limit reclassification — a clean success is never a limit.
function isFailed(exitCode, result) {
  return exitCode !== 0 || result?.is_error === true;
}

// Structured signal: an is_error result tagged with an API-error status, or carrying
// a 429/529 overload code. This ties the numeric code to a real API-error context
// (never a bare number elsewhere in the output).
function structuredLimit(result) {
  if (!result || result.is_error !== true) return false;
  if (result.api_error_status != null && result.api_error_status !== false) return true;
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
