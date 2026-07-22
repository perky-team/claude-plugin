import { describe, expect, it, afterEach } from 'vitest';
import { classifyRun, resolveUsageLimitPattern, parseResetAt, DEFAULT_USAGE_LIMIT_PATTERN } from '../lib/classify.mjs';

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
