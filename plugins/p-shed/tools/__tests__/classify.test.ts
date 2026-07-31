import { describe, expect, it, afterEach } from 'vitest';
import { classifyRun, classifySkipReason, parseUsage, resolveUsageLimitPattern, parseResetAt, DEFAULT_USAGE_LIMIT_PATTERN } from '../lib/classify.mjs';

describe('classifyRun', () => {
  it('classifies a clean exit-0 run as success', () => {
    expect(classifyRun(0, '{"is_error":false,"result":"done"}', '')).toBe('success');
  });

  it('classifies a non-zero crash with no limit signature as failure', () => {
    expect(classifyRun(1, 'panic: runtime error: index out of range', '')).toBe('failure');
    expect(classifyRun(2, '', 'Error: something exploded\n  at foo (x.js:1)')).toBe('failure');
  });

  it('a timeout (exit null) with no limit signature is a failure', () => {
    expect(classifyRun(null, '', '')).toBe('failure');
  });

  describe('subscription usage limits (text) → usage_limit when the run failed', () => {
    for (const msg of [
      '5-hour limit reached ∙ resets 3am',
      'Claude usage limit reached',
      "You've hit your weekly limit",
      'out of extra usage',
      'out of credits',
      'Your credit balance is too low to run this request',
    ]) {
      it(JSON.stringify(msg), () => {
        expect(classifyRun(1, msg, '')).toBe('usage_limit');
      });
    }
  });

  describe('transient API overload (text) → usage_limit', () => {
    for (const msg of [
      'API Error: 529 overloaded_error',
      'API error (429): rate_limit_error',
      'The server is temporarily limiting requests',
    ]) {
      it(JSON.stringify(msg), () => {
        expect(classifyRun(1, '', msg)).toBe('usage_limit');
      });
    }
  });

  it('detects a structured JSON overload (is_error:true + api_error_status:429)', () => {
    const out = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'overloaded' });
    expect(classifyRun(1, out, '')).toBe('usage_limit');
  });

  it('detects a structured JSON error even when the process exited 0 (is_error:true + 529)', () => {
    const out = JSON.stringify({ is_error: true, result: 'API Error: 529' });
    expect(classifyRun(0, out, '')).toBe('usage_limit');
  });

  it('does NOT classify a limit message as usage_limit when the run SUCCEEDED (exit 0, no is_error)', () => {
    // A prompt whose OUTPUT merely contains the phrase must not be mistaken for a real limit.
    expect(classifyRun(0, 'The docs mention that usage limit reached errors exist.', '')).toBe('success');
  });

  it('never matches a bare HTTP number outside an api-error context', () => {
    expect(classifyRun(1, 'Processed 529 records, 429 skipped', '')).toBe('failure');
  });

  it('honours an explicit override pattern argument', () => {
    expect(classifyRun(1, 'weird proprietary throttle notice', '', 'proprietary throttle')).toBe('usage_limit');
    // and a message the override does NOT cover stays a failure
    expect(classifyRun(1, 'usage limit reached', '', 'proprietary throttle')).toBe('failure');
  });

  it('falls back to the built-in pattern when the override is an invalid regex (never throws)', () => {
    expect(() => classifyRun(1, 'Claude usage limit reached', '', '(')).not.toThrow();
    expect(classifyRun(1, 'Claude usage limit reached', '', '(')).toBe('usage_limit');
  });

  // A NON-retryable API error (bad request, expired/revoked credential) is a genuine
  // failure: it will never succeed on retry, so it must reach the breaker instead of
  // becoming an eternal silent skip that looks healthy to any watchdog.
  describe('structured api_error_status: only retryable statuses are limits', () => {
    const structured = (status: number, result = 'boom') =>
      JSON.stringify({ type: 'result', is_error: true, api_error_status: status, result });

    for (const status of [400, 401, 403, 404, 422]) {
      it(`${status} (fatal) → failure, so the breaker counts it`, () => {
        expect(classifyRun(1, structured(status), '')).toBe('failure');
      });
    }

    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      it(`${status} (retryable) → usage_limit`, () => {
        expect(classifyRun(1, structured(status), '')).toBe('usage_limit');
      });
    }

    it('a non-numeric / junk api_error_status is not a limit', () => {
      const out = JSON.stringify({ type: 'result', is_error: true, api_error_status: 'nope', result: 'boom' });
      expect(classifyRun(1, out, '')).toBe('failure');
    });
  });
});

// The recorded reason must say WHICH quota/infra condition caused the skip: a
// subscription limit (burning real quota, carries a reset time) is not the same
// operational state as a transient API overload, and logging both as "usage-limit"
// made a live deployment look quota-starved when it was only seeing 529s.
describe('classifySkipReason', () => {
  describe('subscription / plan limits → usage-limit', () => {
    for (const msg of [
      '5-hour limit reached ∙ resets 3am',
      'Claude usage limit reached',
      "You've hit your weekly limit",
      'out of extra usage',
      'out of credits',
      'Your credit balance is too low to run this request',
    ]) {
      it(JSON.stringify(msg), () => {
        expect(classifySkipReason(msg, '')).toBe('usage-limit');
      });
    }
  });

  describe('transient API overload → api-overload', () => {
    for (const msg of [
      'API Error: 529 overloaded_error',
      'API error (429): rate_limit_error',
      'The server is temporarily limiting requests',
      'API Error: 503 upstream unavailable',
    ]) {
      it(JSON.stringify(msg), () => {
        expect(classifySkipReason('', msg)).toBe('api-overload');
      });
    }

    it('reads a structured api_error_status with no matching text', () => {
      const out = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'overloaded' });
      expect(classifySkipReason(out, '')).toBe('api-overload');
    });
  });

  it('subscription wins when both signatures are present (the more consequential state)', () => {
    const text = 'API Error: 529 overloaded_error\nClaude usage limit reached ∙ resets 3am';
    expect(classifySkipReason(text, '')).toBe('usage-limit');
    expect(classifySkipReason('', text)).toBe('usage-limit');
  });

  it('never throws on empty or non-string input', () => {
    expect(() => classifySkipReason(undefined as any, undefined as any)).not.toThrow();
    expect(() => classifySkipReason('', '')).not.toThrow();
  });
});

describe('resolveUsageLimitPattern', () => {
  const saved = process.env.PSHED_USAGE_LIMIT_PATTERN;
  afterEach(() => {
    if (saved === undefined) delete process.env.PSHED_USAGE_LIMIT_PATTERN;
    else process.env.PSHED_USAGE_LIMIT_PATTERN = saved;
  });

  it('defaults to the built-in pattern', () => {
    delete process.env.PSHED_USAGE_LIMIT_PATTERN;
    expect(resolveUsageLimitPattern()).toBe(DEFAULT_USAGE_LIMIT_PATTERN);
    expect(resolveUsageLimitPattern({})).toBe(DEFAULT_USAGE_LIMIT_PATTERN);
  });

  it('lets jobs.yml defaults.usageLimitPattern win over env and built-in', () => {
    process.env.PSHED_USAGE_LIMIT_PATTERN = 'from-env';
    expect(resolveUsageLimitPattern({ usageLimitPattern: 'from-jobs-yml' })).toBe('from-jobs-yml');
  });

  it('falls back to the env var when jobs.yml does not set one', () => {
    process.env.PSHED_USAGE_LIMIT_PATTERN = 'from-env';
    expect(resolveUsageLimitPattern({})).toBe('from-env');
  });
});

// What a run COST is the one thing the scheduler could never answer: every successful
// run's result JSON was parsed for classification and then dropped, leaving wall-clock
// duration — meaningless across jobs on different models — as the only proxy.
describe('parseUsage', () => {
  const RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 120000,
    duration_api_ms: 98765,
    num_turns: 12,
    total_cost_usd: 0.42,
    usage: { input_tokens: 1234, output_tokens: 5678, cache_read_input_tokens: 90123, cache_creation_input_tokens: 4567 },
    modelUsage: { 'claude-opus-4-5-20260101': { inputTokens: 1234, outputTokens: 5678, costUSD: 0.42 } },
    result: 'done',
  };

  it('extracts a compact block from a full result JSON', () => {
    expect(parseUsage(JSON.stringify(RESULT))).toEqual({
      costUsd: 0.42,
      in: 1234,
      out: 5678,
      cacheRead: 90123,
      cacheCreate: 4567,
      turns: 12,
      apiMs: 98765,
      models: { 'claude-opus-4-5-20260101': { in: 1234, out: 5678, costUsd: 0.42 } },
    });
  });

  // The salvage path matters here: `lastIndexOf('{')` lands on a NESTED brace for a
  // real result (usage/modelUsage are objects), so noise around the JSON used to make
  // the whole result unparseable — losing the classification too, not just the cost.
  it('reuses the salvage parse: a result preceded by log noise still yields usage', () => {
    expect(parseUsage('warning: something on stderr\n' + JSON.stringify(RESULT))?.costUsd).toBe(0.42);
  });

  it('reuses the salvage parse: trailing garbage after the result line still yields usage', () => {
    expect(parseUsage(JSON.stringify(RESULT) + '\nnpm notice: update available')?.costUsd).toBe(0.42);
  });

  it('returns undefined for output that is not a result JSON at all', () => {
    expect(parseUsage('Doing the thing...\nDone.')).toBeUndefined();
    expect(parseUsage('')).toBeUndefined();
    expect(parseUsage(undefined as any)).toBeUndefined();
  });

  it('returns undefined for a parseable result carrying no usage numbers', () => {
    expect(parseUsage(JSON.stringify({ type: 'result', is_error: false, result: 'hi' }))).toBeUndefined();
  });

  it('records the token counts and omits costUsd when total_cost_usd is missing', () => {
    const { total_cost_usd, modelUsage, ...rest } = RESULT;
    const u = parseUsage(JSON.stringify(rest));
    expect(u).toEqual({ in: 1234, out: 5678, cacheRead: 90123, cacheCreate: 4567, turns: 12, apiMs: 98765 });
    expect('costUsd' in (u as object)).toBe(false);
  });

  it('omits non-numeric junk instead of recording it', () => {
    const u = parseUsage(JSON.stringify({
      ...RESULT,
      total_cost_usd: 'lots',
      usage: { input_tokens: 'many', output_tokens: 5678 },
      modelUsage: { m: { inputTokens: null, outputTokens: 'x' } },
    }));
    expect(u?.out).toBe(5678);
    expect(u?.costUsd).toBeUndefined();
    expect(u?.in).toBeUndefined();
    expect(u?.models).toBeUndefined(); // an all-junk model entry is dropped, not stored empty
  });

  it('accepts camelCase field names as well (SDK-shaped result)', () => {
    const camel = {
      totalCostUsd: 0.5, numTurns: 3, durationApiMs: 42,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
    };
    expect(parseUsage(JSON.stringify(camel))).toEqual({ costUsd: 0.5, in: 10, out: 20, cacheRead: 30, cacheCreate: 40, turns: 3, apiMs: 42 });
  });

  it('never throws — a weird run must not be able to wedge the tick', () => {
    for (const bad of ['[]', 'null', 'true', '"str"', '{"usage":null}', '{"usage":42}', '{"modelUsage":"nope"}', '{"modelUsage":{"m":null}}', '{{{{', '{"usage":{"input_tokens":{}}}']) {
      expect(() => parseUsage(bad), bad).not.toThrow();
    }
  });
});

describe('parseResetAt', () => {
  it('extracts a reset time from common phrasings', () => {
    expect(parseResetAt('5-hour limit reached ∙ resets 3am', '')).toBe('3am');
    expect(parseResetAt('usage limit reached, resets at 2026-01-02 15:00 UTC', '')).toBe('2026-01-02 15:00 UTC');
  });
  it('survives a Windows CRLF tail (a real headless run ends with \\r\\n)', () => {
    expect(parseResetAt('5-hour limit reached . resets 3am\r\n', '')).toBe('3am');
  });
  it('returns undefined when the message carries no reset time', () => {
    expect(parseResetAt('Claude usage limit reached', '')).toBeUndefined();
  });
});
